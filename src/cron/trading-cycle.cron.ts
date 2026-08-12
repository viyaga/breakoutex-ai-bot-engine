import cron from "node-cron";
import { env } from "../config";
import errorLogger from "../utils/errorLogger";
import { TradingV2 } from "../services/tradingV2";
import { Data } from "../services/tradingV2/data";
import { TradingConfig } from "../services/tradingV2/config";
import { tradingCronLogger } from "../services/tradingV2/logger";
import { BulkSyncService } from "../services/bulkSync.service";
import { startCycleLogging, endCycleLogging } from "../utils/cycleLogger";

/* ============================================================================
 * Cron Scheduler
 * ============================================================================ */

const tradingCycleCronJob = (): void => {

    cron.schedule(env.cronSchedule, async () => {
        startCycleLogging();
        const startTime = Date.now();
        let totalProcessed = 0;
        let totalSucceeded = 0;
        let totalFailed = 0;
        let offset = 0;
        const LIMIT = 100; // Reduced for better stability
        const CONCURRENCY_PER_EXCHANGE = env.concurrencyPerExchange || 2; // Max parallel bots per exchange

        tradingCronLogger.info(`${'='.repeat(80)}`);
        tradingCronLogger.info(`[TradingCron] ========== CYCLE START ==========`);
        tradingCronLogger.info(`${'='.repeat(80)}`);

        // Clear market data caches for the new cycle
        TradingV2.clearCaches();

        try {
            tradingCronLogger.info(`[TradingCron] Fetching trading configs with LIMIT=${LIMIT}, starting at offset=${offset}...`);

            while (true) {
                const configs = await Data.fetchTradingConfigs({
                    limit: LIMIT,
                    offset: offset
                });

                tradingCronLogger.info(`[TradingCron] Fetched ${configs.length} configs at offset=${offset}`);

                if (configs.length === 0) {
                    tradingCronLogger.info(`[TradingCron] No more configs found. Breaking loop.`);
                    break;
                }

                // 1. Group configs by exchange (e.g., 'delta', 'binance')
                const configsByExchange = configs.reduce((acc, cfg) => {
                    const exchange = (cfg.EXCHANGE || "delta").toLowerCase();
                    if (!acc[exchange]) acc[exchange] = [];
                    acc[exchange].push(cfg);
                    return acc;
                }, {} as Record<string, typeof configs>);

                const exchangeList = Object.keys(configsByExchange);
                tradingCronLogger.info(`[TradingCron] Processing batch of ${configs.length} configs across ${exchangeList.length} exchange(s) (${exchangeList.join(", ")}) with CONCURRENCY_PER_EXCHANGE=${CONCURRENCY_PER_EXCHANGE}...`);

                // 2. Concurrency-limited execution pool per exchange
                const processExchangeGroup = async (exchangeName: string, exchangeConfigs: typeof configs) => {
                    tradingCronLogger.info(`[TradingCron] Starting pool for exchange '${exchangeName}' with ${exchangeConfigs.length} bot(s) (Concurrency=${CONCURRENCY_PER_EXCHANGE})...`);
                    const groupResults: Array<{ config: typeof configs[0]; result: { status: 'fulfilled'; value: any } | { status: 'rejected'; reason: any } }> = [];
                    const executing = new Set<Promise<any>>();

                    for (const cfg of exchangeConfigs) {
                        const p = (async () => {
                            tradingCronLogger.info(`[TradingCron] Starting cycle for config: ${cfg.id} (${cfg.SYMBOL} on ${cfg.EXCHANGE})`);
                            try {
                                const res = await TradingConfig.configStore.run(cfg, () => TradingV2.runTradingCycle(cfg));
                                return { status: 'fulfilled' as const, value: res };
                            } catch (err) {
                                return { status: 'rejected' as const, reason: err };
                            }
                        })();

                        const recordPromise = p.then(res => {
                            groupResults.push({ config: cfg, result: res });
                        });

                        executing.add(p);
                        p.finally(() => executing.delete(p));

                        if (executing.size >= CONCURRENCY_PER_EXCHANGE) {
                            await Promise.race(executing);
                        }
                    }

                    await Promise.all(executing);
                    return groupResults;
                };

                // 3. Run exchange pools in parallel
                const exchangePromises = Object.entries(configsByExchange).map(([exchangeName, exchangeConfigs]) =>
                    processExchangeGroup(exchangeName, exchangeConfigs)
                );

                const exchangeResultsNested = await Promise.all(exchangePromises);
                const allResults = exchangeResultsNested.flat();

                // Count successes and failures
                allResults.forEach(({ config, result }) => {
                    if (result.status === 'fulfilled') {
                        totalSucceeded++;
                        tradingCronLogger.info(`[TradingCron] ✓ Config ${config.id} (${config.SYMBOL} on ${config.EXCHANGE}) completed successfully`);
                    } else {
                        totalFailed++;
                        tradingCronLogger.error(`[TradingCron] ✗ Config ${config.id} (${config.SYMBOL} on ${config.EXCHANGE}) failed:`, { reason: result.reason?.message || result.reason });
                    }
                });

                totalProcessed += configs.length;
                offset += LIMIT;

                tradingCronLogger.info(`[TradingCron] Batch summary: ${configs.length} configs, ${totalSucceeded} succeeded, ${totalFailed} failed`);
                tradingCronLogger.info(`[TradingCron] Total processed so far: ${totalProcessed}`);

                if (configs.length < LIMIT) {
                    tradingCronLogger.info(`[TradingCron] All configs processed. Breaking loop.`);
                    break;
                }
            }

        } catch (error) {
            tradingCronLogger.error(`[TradingCron] CRITICAL ERROR occurred:`, { error });
            errorLogger.error("[TradingCron] Cron cycle failed", error);
        } finally {
            const duration = Date.now() - startTime;
            tradingCronLogger.info(`${'='.repeat(80)}`);
            tradingCronLogger.info(`[TradingCron] ========== CYCLE COMPLETE =========="`);
            tradingCronLogger.info(`[TradingCron] Total Processed: ${totalProcessed}`);
            tradingCronLogger.info(`[TradingCron] Succeeded: ${totalSucceeded} | Failed: ${totalFailed}`);
            tradingCronLogger.info(`[TradingCron] Duration: ${duration}ms (${(duration / 1000).toFixed(2)}s)`);
            tradingCronLogger.info(`${'='.repeat(80)}`);
            
            // 🚀 Trigger Payload sync after the cycle finishes
            tradingCronLogger.info(`[TradingCron] Chaining Payload synchronization...`);
            await BulkSyncService.runFullSync();
            
            tradingCronLogger.info(`${'='.repeat(80)}`);
            endCycleLogging();
        }
    });

    tradingCronLogger.info(`[CronScheduler] Trading cycle cron job scheduled: "${env.cronSchedule}"`);
    tradingCronLogger.info(`[CronScheduler] Next execution will be triggered based on the schedule.`);
};

export default tradingCycleCronJob;