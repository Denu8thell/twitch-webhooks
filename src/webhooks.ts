import {NextFunction} from "express";
import * as express from "express";
import * as crypto from "crypto";
import concat = require("concat-stream");
import {createErrorFromResponse, SubscriptionDeniedError} from "./errors";
import {EventEmitter} from "events";
import {IResubscribeable, WebhookRenewalScheduler} from "./scheduling";
import {
    createWebhookPersistenceObject,
    getIdFromTypeAndParams,
    MemoryBasedTwitchWebhookPersistenceManager,
    WebhookPersistenceObject
} from "./persistence";
import {
    WebhookType,
    WebhookOptions,
    TwitchWebhookManagerConfig,
    TwitchWebhookManagerConfig_Internal
} from "./config";
import got from 'got';
import {
    ChannelBanChangedSubParams,
    convertPayload, ExtensionTransactionCreatedSubParams, ModeratorChangedSubParams,
    StreamChangedSubParams, SubscriptionSubParams,
    UserChangedSubParams,
    UserFollowsSubParams,
    WebhookPayload
} from "./payload_types";
import {getCallbackUrl, getEndpointPath, getWebhookParamsFromId} from "./util";

const TWITCH_HUB_URL = "https://api.twitch.tv/helix/webhooks/hub";
type WebhookId = string;

type HubParams = {
    'hub.callback': string;
    'hub.mode': string;
    'hub.topic': string;
    'hub.lease_seconds': number;
    'hub.secret': string;
};

declare interface TwitchWebhookManager {
    //General events
    emit(event: 'message', webhookId: WebhookId, payload: WebhookPayload<any>): boolean;

    on(event: 'message', callback: (webhookId: WebhookId, payload: WebhookPayload<any>) => void): this;

    emit(event: 'error', e: Error, webhookId?: WebhookId): this

    on(event: 'error', callback: (e: Error, webhookId?: WebhookId) => void): this

    emit(event: 'subscribed', webhookId: WebhookId): this

    on(event: 'subscribed', callback: (webhookId: WebhookId) => void): this

    emit(event: 'unsubscribed', webhookId: WebhookId): this

    on(event: 'unsubscribed', callback: (webhookId: WebhookId) => void): this

    //Events for specific event types.
    emit(event: 'userFollows', webhookId: WebhookId, payload: WebhookPayload<WebhookType.UserFollows>): boolean;

    emit(event: 'streamChanged', webhookId: WebhookId, payload: WebhookPayload<WebhookType.StreamChanged>): boolean;

    emit(event: 'userChanged', webhookId: WebhookId, payload: WebhookPayload<WebhookType.UserChanged>): boolean;

    emit(event: 'extensionTransactionCreated', webhookId: WebhookId, payload: WebhookPayload<WebhookType.ExtensionTransactionCreated>): boolean;

    emit(event: 'moderatorChangeEvent', webhookId: WebhookId, payload: WebhookPayload<WebhookType.ModeratorChange>): boolean;

    emit(event: 'channelBanEvent', webhookId: WebhookId, payload: WebhookPayload<WebhookType.ChannelBanChange>): boolean;

    emit(event: 'subscriptionEvent', webhookId: WebhookId, payload: WebhookPayload<WebhookType.Subscription>): boolean;

    on(event: 'userFollows', callback: (webhookId: WebhookId, payload: WebhookPayload<WebhookType.UserFollows>) => void): this;

    on(event: 'streamChanged', callback: (webhookId: WebhookId, payload: WebhookPayload<WebhookType.StreamChanged>) => void): this;

    on(event: 'userChanged', callback: (webhookId: WebhookId, payload: WebhookPayload<WebhookType.UserChanged>) => void): this;

    on(event: 'extensionTransactionCreated', callback: (webhookId: WebhookId, payload: WebhookPayload<WebhookType.ExtensionTransactionCreated>) => void): this;

    on(event: 'moderatorChangeEvent', callback: (webhookId: WebhookId, payload: WebhookPayload<WebhookType.ModeratorChange>) => void): this;

    on(event: 'channelBanEvent', callback: (webhookId: WebhookId, payload: WebhookPayload<WebhookType.ChannelBanChange>) => void): this;

    on(event: 'subscriptionEvent', callback: (webhookId: WebhookId, payload: WebhookPayload<WebhookType.Subscription>) => void): this;

}

class TwitchWebhookManager extends EventEmitter implements IResubscribeable{
    readonly config: TwitchWebhookManagerConfig_Internal;
    renewalInterval: NodeJS.Timeout | undefined;

    constructor(config: TwitchWebhookManagerConfig) {
        super({captureRejections: true});
        this.config = Object.assign({
            secret: crypto.randomBytes(90).toString("hex"), // Note; the max length of this secret is 200; The default is 180 characters.
            persistenceManager: new MemoryBasedTwitchWebhookPersistenceManager(),
            hubUrl: TWITCH_HUB_URL,
            logger: {
                debug: (_1: any, ..._2: any[]) => {
                },
                info: (_1: any, ..._2: any[]) => {
                },
                error: (_1: any, ..._2: any[]) => {
                }
            }
        }, config);

        this.addWebhookEndpoints();

        if (config.renewalScheduler) {
            if (config.renewalScheduler.getMetaData().runInterval !== Infinity) {
                this.renewalInterval = setInterval(() => (<WebhookRenewalScheduler>config.renewalScheduler).run(), config.renewalScheduler.getMetaData().runInterval)
            }
            config.renewalScheduler.setResubscribeableObject(this);
        }
    }

    async init(): Promise<void> {
        if (this.config.renewalScheduler) {
            this.config.logger.info('Initializing renewal scheduler:');
            let webhooks = await this.config.persistenceManager.getAllWebhooks();
            this.config.logger.debug('Adding webhooks to renewal scheduler: ', webhooks);
            for (let webhook of webhooks) {
                this.config.renewalScheduler.addToScheduler(webhook);
            }
        }
    }

    // Safely shuts down all related/owned function of the webhook manager - no data is necessarily destroyed,
    // Although it depends on the behaviour of the persistence manager
    public async destroy() {
        this.config.logger.info('Destroying Webhook Manager');
        if (this.renewalInterval) {
            this.config.logger.info('Deleting renewal run interval.');
            clearInterval(this.renewalInterval);
            this.renewalInterval = undefined;
        }

        if (this.config.renewalScheduler) {
            this.config.logger.info('Destroying renewal scheduler.');
            await this.config.renewalScheduler.destroy();
            this.config.renewalScheduler = undefined;
        }

        if (this.config.persistenceManager) {
            this.config.logger.info('Destroying persistence manager.');
            await this.config.persistenceManager.destroy();
        }
    }

    //Unsubscribes from all webhook endpoints.
    public async unsubFromAll() {
        this.config.logger.info('Unsubbing from all webhook endpoints');
        let promises = [];
        let webhooks = await this.config.persistenceManager.getAllWebhooks();
        let webhookIds = webhooks.map((x) => x.id);
        let finalPromise = new Promise((resolve, _) => {
            this.on('unsubscribed', (id: WebhookId)=>{
                webhookIds = webhookIds.filter(x => x!==id);
                if(webhookIds.length == 0){
                    resolve();
                }
            });
        });


        for (let webhook of webhooks) {
            promises.push(this.unsubscribePersistenceObject(webhook)
                .catch((e) => {
                    this.config.logger.error(`Error while unsubscribing from: ${webhook.id}`, e);
                }));
        }

        await Promise.all(promises);
        await finalPromise;
    }

    public async addUserFollowsSubscription(config: WebhookOptions, subParams: UserFollowsSubParams): Promise<WebhookId> {
        this.config.logger.info(`Adding user follows subscription: to_id: ${subParams.to_id}, from_id: ${subParams.from_id}`);
        if (!subParams.to_id && !subParams.from_id) {
            throw new Error("to_id or from_id (or both) must be specified!");
        }

        let params = new Map<string, string>();

        params.set("first", "1");

        if (subParams.to_id) {
            params.set("to_id", subParams.to_id);
        }

        if (subParams.from_id) {
            params.set("from_id", subParams.from_id);
        }
        return await this.subscribeOrGetSubscription(WebhookType.UserFollows, params, config);
    }

    public async addStreamChangedSubscription(config: WebhookOptions, subParams: StreamChangedSubParams): Promise<WebhookId> {
        this.config.logger.info(`Adding stream changed subscription: user_id: ${subParams.user_id}`);
        let params = new Map<string, string>();
        params.set("user_id", subParams.user_id);

        return await this.subscribeOrGetSubscription(WebhookType.StreamChanged, params, config);
    }

    public async addUserChangedSubscription(config: WebhookOptions, subParams: UserChangedSubParams): Promise<WebhookId> {
        this.config.logger.info(`Adding user changed subscription: user_id: ${subParams.user_id}`);
        let params = new Map<string, string>();
        params.set("id", subParams.user_id);

        return await this.subscribeOrGetSubscription(WebhookType.UserChanged, params, config, subParams.user_id);
    }

    public async addExtensionTransactionCreatedSubscription(config: WebhookOptions, subParams: ExtensionTransactionCreatedSubParams): Promise<WebhookId> {
        this.config.logger.info(`Adding extension transaction created subscription: user_id: ${subParams.extension_id}`);
        let params = new Map<string, string>();
        params.set("extension_id", subParams.extension_id);
        params.set("first", "1");

        return await this.subscribeOrGetSubscription(WebhookType.ExtensionTransactionCreated, params, config);
    }

    public async addModeratorChangedSubscription(config: WebhookOptions, subParams: ModeratorChangedSubParams): Promise<WebhookId> {
        this.config.logger.info(`Adding moderator changed subscription: broadcaster_id: ${subParams.broadcaster_id}, user_id: ${subParams.user_id}`);
        let params = new Map<string, string>();
        params.set("first", "1");
        params.set("broadcaster_id", subParams.broadcaster_id);

        if (subParams.user_id) {
            params.set("user_id", subParams.user_id);
        }

        return await this.subscribeOrGetSubscription(WebhookType.ModeratorChange, params, config, subParams.broadcaster_id);
    }

    public async addChannelBanChangedSubscription(config: WebhookOptions, subParams: ChannelBanChangedSubParams): Promise<WebhookId> {
        this.config.logger.info(`Adding channel ban changed subscription: broadcaster_id: ${subParams.broadcaster_id}, user_id: ${subParams.user_id}`);
        let params = new Map<string, string>();
        params.set("first", "1");
        params.set("broadcaster_id", subParams.broadcaster_id);

        if (subParams.user_id) {
            params.set("user_id", subParams.user_id);
        }

        return await this.subscribeOrGetSubscription(WebhookType.ChannelBanChange, params, config, subParams.broadcaster_id);
    }

    public async addSubscriptionSubscription(config: WebhookOptions, subParams: SubscriptionSubParams): Promise<WebhookId> {
        this.config.logger.info(`Adding subscription subscription: broadcaster_id: ${subParams.broadcaster_id}, user_id: ${subParams.user_id}, gifter_id: ${subParams.gifter_id}, gifter_name: ${subParams.gifter_name}`);
        let params = new Map<string, string>();
        params.set("broadcaster_id", subParams.broadcaster_id);
        params.set("first", "1");
        if (subParams.user_id) {
            params.set("user_id", subParams.user_id);
        }

        if (subParams.gifter_id) {
            params.set("gifter_id", subParams.gifter_id);
        }

        if (subParams.gifter_name) {
            params.set("gifter_name", subParams.gifter_name);
        }

        return await this.subscribeOrGetSubscription(WebhookType.Subscription, params, config, subParams.broadcaster_id);
    }

    public async unsubscribe(webhookId: WebhookId): Promise<void> {
        let webhook = await this.config.persistenceManager.getWebhookById(webhookId);
        if (webhook) {
            this.unsubscribePersistenceObject(webhook);
        } else {
            throw Error(`Webhook with id ${webhookId} could not be found!`);
        }
    }

    public async unsubscribePersistenceObject(webhook: WebhookPersistenceObject): Promise<void> {
        this.config.logger.info(`Unsubscribing from webhook ${webhook.id}`);
        this.config.logger.debug(`Unsubbing from: `, webhook);
        await this.changeSub(webhook, false);

        //Don't renew anymore
        if (this.config.renewalScheduler) {
            this.config.renewalScheduler.removeFromScheduler(webhook.id);
        }
    }

    public async resubscribe(webhookId: WebhookId): Promise<void> {
        //We do not need to check if the webhook is subscribed;
        //If the webhook is subscribed already, it will simply be renewed.
        let webhook = await this.config.persistenceManager.getWebhookById(webhookId);
        if (webhook) {
            await this.changeSub(webhook, true);
        } else {
            throw Error(`Webhook with id ${webhookId} could not be found!`);
        }
    }

    public async resubscribePersistenceObject(webhook: WebhookPersistenceObject): Promise<void> {
        this.config.logger.info(`Resubbing to webhook: ${webhook.id}`);
        this.config.logger.debug(`Resubbing to: `, webhook);
        //We do not need to check if the webhook is subscribed;
        //If the webhook is subscribed already, it will simply be renewed.
        await this.changeSub(webhook, true);
    }

    private async subscribeOrGetSubscription(type: WebhookType, params: Map<string, string>, config: WebhookOptions, associatedUser?: string): Promise<WebhookId> {
        let webhook = createWebhookPersistenceObject(this, type, params, config);

        let oldWebhook = await this.config.persistenceManager.getWebhookById(webhook.id);
        if (oldWebhook) {
            this.config.logger.info(`Trying to sub to ${webhook.id}, but it was already subbed to! Ignoring request, returning id...`);
            return oldWebhook.id;
        }

        await this.config.persistenceManager.persistWebhook(webhook);
        await this.changeSub(webhook, true, associatedUser);
        return webhook.id;
    }

    private async changeSub(webhook: WebhookPersistenceObject, subscribe: boolean, userId?: string): Promise<void> {
        let callbackUrl = getCallbackUrl(this, webhook);
        let hubParams: HubParams = {
            "hub.callback": callbackUrl,
            "hub.mode": subscribe ? 'subscribe' : 'unsubscribe',
            "hub.topic": webhook.href,
            "hub.lease_seconds": webhook.leaseSeconds,
            "hub.secret": webhook.secret
        };

        let token = await this.config.getOAuthToken(userId);
        return doHubRequest(webhook, this, hubParams, token);
    }

    //Hooks configured endpoints into the express app.
    private addWebhookEndpoints() {
        let app = this.config.app;

        // Middleware that will catch requests and validate that they match up with the hub secret
        let verification_middleware = getVerificationMiddleware(this);

        for (let type in Object.keys(WebhookType).filter(x => !isNaN(Number(x)))) {
            let endpoint_path = getEndpointPath(this.config.base_path, Number(type));
            this.config.logger.info(`Listening on endpoint: ${endpoint_path}`);
            //Configure middleware
            app.use(endpoint_path, verification_middleware);
            app.use(endpoint_path, express.urlencoded({
                extended: false
            }));

            app.post(endpoint_path, async (req, res) => {
                let webhookId = getIdFromTypeAndParams(Number(type), new URL(req.originalUrl, `https://${req.headers.host}`).search);
                let webhook = await this.config.persistenceManager.getWebhookById(webhookId);
                if (webhook) {
                    res.status(200);
                    res.end();

                    let webhookPayload = {
                        type: Number(type),
                        data: convertPayload(Number(type), req.body.data[0]),
                        subParams: getWebhookParamsFromId(Number(type), webhookId)
                    };

                    this.config.logger.debug('Got message: ', webhookPayload);
                    this.emit('message', webhookId, webhookPayload);
                    this.emitSpecificEvent(webhookId, webhookPayload);
                } else {
                    res.status(404);
                    this.config.logger.error(`Got POST for unknown webhook URL: ${req.originalUrl}`);
                }
            });

            app.get(endpoint_path, async (req, res) => {
                let originalUrl = new URL(req.originalUrl, this.config.hostname);
                if (!originalUrl.searchParams.get("hub.topic")) {
                    throw new Error('hub.topic not found in search params.');
                }

                let topicURL = new URL(decodeURIComponent(<string>originalUrl.searchParams.get("hub.topic")));
                let webhookId = getIdFromTypeAndParams(Number(type), topicURL.search);
                let webhook = await this.config.persistenceManager.getWebhookById(webhookId);

                if (webhook) {
                    if (!originalUrl.searchParams.get("hub.mode") || originalUrl.searchParams.get("hub.mode") === "denied") {
                        res.end();
                        this.config.logger.error(`Subscription denied. reason: ${originalUrl.searchParams.get("hub.reason")}`);

                        await this.config.persistenceManager.deleteWebhook(webhookId);
                        this.emit('error', new SubscriptionDeniedError(webhook, originalUrl.searchParams.get("hub.reason") ? <string>originalUrl.searchParams.get("hub.reason") : 'No reason given'));
                        return;
                    }

                    if(originalUrl.searchParams.get("hub.mode") === 'unsubscribe'){
                        //Confirming unsubscription!
                        await this.config.persistenceManager.deleteWebhook(webhook.id);
                        this.config.logger.info(`Confirmed unsubscription from webhook ${webhook.id}`);

                        res.setHeader("Content-Type", "text/plain");
                        res.status(200);
                        res.end(originalUrl.searchParams.get("hub.challenge"));

                        this.emit('unsubscribed', webhook.id);
                    } else {
                        webhook.subscriptionStart = new Date();

                        if (originalUrl.searchParams.get("hub.lease_seconds")) {
                            webhook.subscriptionEnd = new Date(webhook.subscriptionStart.getTime() + parseInt(<string>originalUrl.searchParams.get("hub.lease_seconds")) * 1000);
                        } else {
                            webhook.subscriptionEnd = new Date(Date.now() + webhook.leaseSeconds * 1000); // Assume lease seconds we sent is respected.
                        }

                        webhook.subscribed = true;
                        res.setHeader("Content-Type", "text/plain");
                        res.status(200);
                        res.end(originalUrl.searchParams.get("hub.challenge"));

                        await this.config.persistenceManager.saveWebhook(webhook);
                        this.config.logger.info(`Subscription for ${webhook.id} verified!`);
                        this.config.logger.debug('Subscribed to webhook: ', webhook);
                        this.emit("subscribed", webhookId);

                        if (this.config.renewalScheduler) {
                            this.config.logger.info(`Adding webhook ${webhook.id} to renewal scheduler`);
                            this.config.renewalScheduler.addToScheduler(webhook);
                        }
                    }
                } else {
                    this.config.logger.error(`Got GET for unknown webhook URL: ${topicURL.href}`);
                    res.status(404);
                    res.end();
                }
            });
        }
    }

    private emitSpecificEvent(webhookId: WebhookId, payload: WebhookPayload<any>): void {
        switch (payload.type) {
            case WebhookType.UserFollows:
                this.emit('userFollows', webhookId, payload);
                break;
            case WebhookType.StreamChanged:
                this.emit('streamChanged', webhookId, payload);
                break;
            case WebhookType.UserChanged:
                this.emit('userChanged', webhookId, payload);
                break;
            case WebhookType.ExtensionTransactionCreated:
                this.emit('extensionTransactionCreated', webhookId, payload);
                break;
            case WebhookType.ModeratorChange:
                this.emit('moderatorChangeEvent', webhookId, payload);
                break;
            case WebhookType.ChannelBanChange:
                this.emit('channelBanEvent', webhookId, payload);
                break;
            case WebhookType.Subscription:
                this.emit('subscriptionEvent', webhookId, payload);
                break;
            default:
                break;
        }
    }
}

//Do a request to the Twitch WebSub hub.
async function doHubRequest(webhook: WebhookPersistenceObject, manager: TwitchWebhookManager, hubParams: HubParams, oAuthToken: string) {
    let paramJson = Buffer.from(JSON.stringify(hubParams), 'utf8');

    manager.config.logger.debug(`Making hub request with: `, hubParams);

    let resp = await got.post(manager.config.hubUrl, {
        headers: {
            "Authorization": `Bearer ${oAuthToken}`,
            "Client-ID": manager.config.client_id,
            "Content-Type": 'application/json',
        },
        timeout: 10000,
        retry: 0,
        body: paramJson
    });

    if (resp.statusCode && Math.floor(resp.statusCode / 100) === 2) {
        return;
    } else if (resp.statusCode === 401) {
        //Retry
        let resp = await got.post(manager.config.hubUrl, {
            headers: {
                "Authorization": `Bearer ${await manager.config.refreshOAuthToken(oAuthToken)}`,
                "Client-ID": manager.config.client_id,
                "Content-Type": 'application/json',
            },
            timeout: 10000,
            retry: 0,
            body: paramJson
        });

        if (resp.statusCode && Math.floor(resp.statusCode / 100) === 2) {
            return;
        }

        throw createErrorFromResponse(resp, resp.body) || new Error('Unknown error when doing hub request: ' + resp.body);
    } else {
        throw createErrorFromResponse(resp, resp.body) || new Error('Unknown error when doing hub request: ' + resp.body);
    }
}


function getVerificationMiddleware(twitchWebhookManager: TwitchWebhookManager) {
    return async function verificationMiddleware(req: express.Request, res: express.Response, next: NextFunction) {
        // We take care of the JSON body parsing here; This is a side effect of how middleware and streams work,
        // so we can't just use the json body parsing middleware...
        req.pipe(concat(async (body) => {
            if (req.header("content-type") && (<string>req.header("content-type")).includes('application/json')) {
                req.body = JSON.parse(body.toString("utf8"));
            }

            if (req.method == 'POST') {
                // Only POST requests matter for secret validation;
                // GET requests are simply to validate the publishing was correct,
                // and are not signed since it is not a notification payload.
                if (req.header("X-Hub-Signature")) {
                    let callback_url = new URL(req.originalUrl, `https://${req.headers.host}`);
                    let splitPath = callback_url.pathname.split('/');
                    let lastPath = splitPath[splitPath.length - 1];
                    let webhook = await (twitchWebhookManager.config.persistenceManager).getWebhookById(lastPath + callback_url.search);

                    let secret: string;
                    if (webhook) {
                        secret = webhook.secret;
                    } else {
                        twitchWebhookManager.config.logger.error(`Webhook ${lastPath + callback_url.search} not found.`);
                        res.sendStatus(404);
                        res.end();
                        return;
                    }

                    let digest = crypto.createHmac('sha256', secret).update(body).digest('hex');

                    if (digest === (<string>req.header("X-Hub-Signature")).split('=')[1]) {
                        next();
                    } else {
                        twitchWebhookManager.config.logger.error("Request gave bad X-Hub-Signature; Rejecting request.");
                        res.sendStatus(400);
                        res.end();
                    }
                } else {
                    twitchWebhookManager.config.logger.error("Request had no X-Hub-Signature header; Rejecting request.");
                    res.sendStatus(400);
                    res.end();
                }
            } else {
                next();
            }
        }));
    };
}


export {
    TwitchWebhookManager,
    WebhookId
}