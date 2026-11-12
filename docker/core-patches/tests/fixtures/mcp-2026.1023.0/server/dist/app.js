import { createMcpApiDispatch, createPublicMcpExecutor } from "./services/public-mcp/capabilities.js";
    let publicMcpEvents = null;
    let dotMcpEvents = null;
    if (publicMcpOAuth) {
        const dispatch = createMcpApiDispatch(api);
        publicMcpEvents = createPublicMcpEvents(db, publicMcpOAuth, dispatch, {
            isBackgroundWorkEnabled: () => !isWarmStandby() && !isIdleTaskDrainActive(),
        });
        publicMcpEvents.start();
        const transfers = createPublicMcpTransfers(db, publicMcpOAuth, dispatch, opts.storageService);
        publicMcpIngress.use(transfers.router);
        publicMcpIngress.use(publicMcpIngressRoutes(publicMcpOAuth, createPublicMcpExecutor(db, publicMcpOAuth, dispatch, transfers), publicMcpEvents));
        const dotOAuth = createPublicMcpOAuth(db, { ...publicMcpOAuth.config, resource: publicMcpOAuth.config.origin + "/mcp/runner" });
        dotMcpEvents = createPublicMcpEvents(db, dotOAuth, dispatch, { enableDotRunner: true, isBackgroundWorkEnabled: () => !isWarmStandby() && !isIdleTaskDrainActive() });
        dotMcpEvents.start();
        publicMcpIngress.use(publicMcpIngressRoutes(dotOAuth, createPublicMcpExecutor(db, dotOAuth, dispatch), dotMcpEvents, createDotRunnerMcpTools(db, connectionIntentHeartbeat)));
        api.use(publicMcpManagementRoutes(publicMcpOAuth, dotOAuth));
        api.use(dotRunnerRoutes(db, publicMcpOAuth.config.origin + "/mcp/runner"));
    }
    app.use("/api", api);
