import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    makeInMemoryStore,
    delay
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import NodeCache from '@cacheable/node-cache';
import pino from 'pino';
import config from '../config.js';
import logger from './logger.js';
import MessageHandler from './message-handler.js';
import ModuleLoader from './module-loader.js';
import TelegramBridge from '../telegram/bridge.js';
import { useMongoAuthState } from '../utils/mongoAuthState.js';
import { connectDb } from '../utils/db.js';

const msgRetryCounterCache = new NodeCache();

export class HyperWaBot {
    constructor() {
        this.sock = null;
        this.store = null;
        this.messageHandler = null;
        this.moduleLoader = null;
        this.telegramBridge = null;
        this.db = null;
        this.isInitialized = false;
        this.retryCount = 0;
        this.maxRetries = 5;
    }

    async initialize() {
        try {
            logger.info('Initializing HyperWa Bot...');

            this.db = await connectDb();
            logger.info('Database connected');

            this.messageHandler = new MessageHandler(this);
            this.moduleLoader = new ModuleLoader(this);

            await this.startConnection();

            this.isInitialized = true;
            logger.info('HyperWa Bot initialization complete');

        } catch (error) {
            logger.error('Failed to initialize bot:', error);
            throw error;
        }
    }

    async startConnection() {
        try {
            const useMongoAuth = config.get('auth.useMongoAuth');
            const clearAuthOnStart = config.get('auth.clearAuthOnStart');

            let state, saveCreds;

            if (useMongoAuth) {
                logger.info('Using MongoDB authentication state');
                const authState = await useMongoAuthState();
                state = authState.state;
                saveCreds = authState.saveCreds;
            } else {
                logger.info('Using file-based authentication state');
                const authState = await useMultiFileAuthState('auth_info');
                state = authState.state;
                saveCreds = authState.saveCreds;
            }

            const { version, isLatest } = await fetchLatestBaileysVersion();
            logger.info(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

            this.store = makeInMemoryStore({
                logger: pino({ level: 'silent' })
            });

            this.sock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger)
                },
                msgRetryCounterCache,
                generateHighQualityLinkPreview: true,
                getMessage: this.getMessage.bind(this),
                syncFullHistory: false,
                printQRInTerminal: !config.get('telegram.enabled'),
                browser: ['HyperWa', 'Chrome', '3.0.0']
            });

            this.store.bind(this.sock.ev);

            this.setupEventHandlers(saveCreds);

            logger.info('WhatsApp connection started');

        } catch (error) {
            logger.error('Failed to start connection:', error);
            throw error;
        }
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.process(async (events) => {
            if (events['connection.update']) {
                await this.handleConnectionUpdate(events['connection.update']);
            }

            if (events['creds.update']) {
                await saveCreds();
            }

            if (events['messages.upsert']) {
                await this.messageHandler.handleMessages(events['messages.upsert']);
            }

            if (events['messages.update']) {
                logger.debug('Messages updated:', events['messages.update'].length);
            }

            if (events['message-receipt.update']) {
                logger.debug('Message receipt updated');
            }

            if (events['messages.reaction']) {
                logger.debug('Message reaction received');
            }

            if (events['presence.update']) {
                logger.debug('Presence update:', events['presence.update']);
            }

            if (events['chats.update']) {
                logger.debug('Chats updated:', events['chats.update'].length);
            }

            if (events['chats.delete']) {
                logger.debug('Chats deleted:', events['chats.delete'].length);
            }

            if (events['contacts.update']) {
                for (const contact of events['contacts.update']) {
                    if (typeof contact.imgUrl !== 'undefined') {
                        const newUrl = contact.imgUrl === null
                            ? null
                            : await this.sock.profilePictureUrl(contact.id).catch(() => null);

                        if (newUrl) {
                            logger.debug(`Contact ${contact.id} has a new profile pic: ${newUrl}`);
                        }
                    }
                }
            }

            if (events['contacts.upsert']) {
                logger.debug('New contacts:', events['contacts.upsert'].length);
            }

            if (events.call) {
                logger.info('Call event received:', events.call);
                if (this.telegramBridge) {
                    for (const call of events.call) {
                        await this.telegramBridge.handleCallNotification(call);
                    }
                }
            }

            if (events['messaging-history.set']) {
                const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set'];
                logger.info(`Received ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (latest: ${isLatest}, progress: ${progress}%)`);
            }

            if (events['labels.association']) {
                logger.debug('Label association:', events['labels.association']);
            }

            if (events['labels.edit']) {
                logger.debug('Label edited:', events['labels.edit']);
            }
        });
    }

    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info('QR Code received');

            if (this.telegramBridge) {
                await this.telegramBridge.sendQRCode(qr);
            } else {
                const QRCode = (await import('qrcode-terminal')).default;
                QRCode.generate(qr, { small: true });
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true;

            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode
                : null;

            logger.info(`Connection closed due to ${lastDisconnect?.error?.message || 'unknown reason'}, reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                if (this.retryCount < this.maxRetries) {
                    this.retryCount++;
                    const retryDelay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
                    logger.info(`Reconnecting in ${retryDelay / 1000} seconds (attempt ${this.retryCount}/${this.maxRetries})...`);

                    await delay(retryDelay);
                    await this.startConnection();
                } else {
                    logger.error('Max reconnection attempts reached. Please restart the bot.');
                    if (this.telegramBridge) {
                        await this.telegramBridge.sendToAllUsers('Connection lost. Max reconnection attempts reached. Please restart the bot.');
                    }
                }
            } else {
                logger.info('Connection closed permanently. You are logged out.');
                if (this.telegramBridge) {
                    await this.telegramBridge.sendToAllUsers('WhatsApp connection closed. You have been logged out.');
                }
            }
        }

        if (connection === 'open') {
            logger.info('WhatsApp connection opened successfully');
            logger.info(`Connected as: ${this.sock.user?.name || 'Unknown'} (${this.sock.user?.id || 'Unknown ID'})`);

            this.retryCount = 0;

            await this.moduleLoader.loadModules();

            if (config.get('telegram.enabled')) {
                if (!this.telegramBridge) {
                    this.telegramBridge = new TelegramBridge(this);
                    await this.telegramBridge.initialize();
                    await this.telegramBridge.setupWhatsAppHandlers();
                }

                await this.telegramBridge.syncContacts();
                await this.telegramBridge.updateTopicNames();
                await this.telegramBridge.sendStartMessage();
            }
        }

        if (connection === 'connecting') {
            logger.info('Connecting to WhatsApp...');
        }
    }

    async getMessage(key) {
        if (this.store) {
            const msg = await this.store.loadMessage(key.remoteJid, key.id);
            return msg?.message || undefined;
        }
        return undefined;
    }

    async sendMessage(jid, content, options = {}) {
        try {
            if (!this.sock) {
                throw new Error('WhatsApp socket not initialized');
            }

            const result = await this.sock.sendMessage(jid, content, options);
            return result;

        } catch (error) {
            logger.error('Failed to send message:', error);
            throw error;
        }
    }

    getContactInfo(jid) {
        if (!jid || !this.store?.contacts) return null;
        return this.store.contacts[jid];
    }

    async shutdown() {
        logger.info('Shutting down HyperWa Bot...');

        try {
            if (this.telegramBridge) {
                await this.telegramBridge.shutdown();
            }

            if (this.sock) {
                this.sock.end();
            }

            logger.info('HyperWa Bot shutdown complete');
        } catch (error) {
            logger.error('Error during shutdown:', error);
        }
    }
}

export default HyperWaBot;
