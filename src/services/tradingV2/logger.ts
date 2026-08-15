import util from "util";
import fs from "fs";
import path from "path";
import { promoteCurrentCycleToHighScore } from "../../utils/cycleLogger";

export const HIGH_SCORE_LOG_DIR = path.join(process.cwd(), "logs", "high_scores");
export const MAX_HIGH_SCORE_LOG_FILES = 10;

/**
 * Rotates log files in HIGH_SCORE_LOG_DIR to keep at most MAX_HIGH_SCORE_LOG_FILES (10).
 * Oldest log files are deleted if total files exceeds MAX_HIGH_SCORE_LOG_FILES.
 */
export const rotateHighScoreLogs = (): void => {
    try {
        if (!fs.existsSync(HIGH_SCORE_LOG_DIR)) return;

        const files = fs.readdirSync(HIGH_SCORE_LOG_DIR);
        const logFiles = files
            .map(f => {
                const filePath = path.join(HIGH_SCORE_LOG_DIR, f);
                let time = 0;
                try {
                    const stat = fs.statSync(filePath);
                    if (!stat.isFile()) return null;
                    time = stat.mtimeMs;
                } catch {
                    return null;
                }
                return { name: f, path: filePath, time };
            })
            .filter((item): item is { name: string; path: string; time: number } => item !== null)
            .sort((a, b) => a.time - b.time); // Oldest first

        if (logFiles.length > MAX_HIGH_SCORE_LOG_FILES) {
            const deleteCount = logFiles.length - MAX_HIGH_SCORE_LOG_FILES;
            for (let i = 0; i < deleteCount; i++) {
                try {
                    fs.unlinkSync(logFiles[i].path);
                } catch (unlinkErr) {
                    console.error(`Failed to delete old high score log file ${logFiles[i].name}:`, unlinkErr);
                }
            }
        }
    } catch (err) {
        console.error("Error rotating high score logs:", err);
    }
};

/**
 * Returns path to the current high score log file (timestamped by date YYYYMMDD).
 */
export const getHighScoreLogPath = (date: Date = new Date()): string => {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return path.join(HIGH_SCORE_LOG_DIR, `high_score_${year}${month}${day}.log`);
};

/**
 * Logs entries to logs/high_scores directory.
 * Stores up to a maximum of 10 files in HIGH_SCORE_LOG_DIR. Old log files are automatically deleted.
 */
export class CycleLogCollector {
    private logs: string[] = [];

    addLog(formattedMessage: string): void {
        this.logs.push(formattedMessage);
    }

    getLogs(): string[] {
        return [...this.logs];
    }

    getFormattedTrace(): string {
        return this.logs.join("\n");
    }

    clear(): void {
        this.logs = [];
    }
}

/**
 * Logs entries to logs/high_scores directory.
 * Stores up to a maximum of 10 files in HIGH_SCORE_LOG_DIR. Old log files are automatically deleted.
 */
export const logHighScore = (message: string, meta?: any): void => {
    try {
        // Attempt to promote exact active cycle log file if active
        const details = meta?.details || (typeof meta === "object" && meta?.symbol ? meta : undefined);
        const promoted = promoteCurrentCycleToHighScore(details);
        if (promoted) return;

        if (!fs.existsSync(HIGH_SCORE_LOG_DIR)) {
            fs.mkdirSync(HIGH_SCORE_LOG_DIR, { recursive: true });
        }

        rotateHighScoreLogs();

        const logFilePath = getHighScoreLogPath();
        const timestamp = new Date().toISOString();
        let logLine = `${timestamp} ${message}`;
        if (meta) {
            if (meta instanceof Error) {
                logLine += `\n${meta.stack || meta.message}`;
            } else if (typeof meta === "string") {
                logLine += `\n${meta}`;
            } else if (Object.keys(meta).length > 0 && !meta.collector && !meta.details) {
                logLine += ` ${util.inspect(meta, { depth: 4 })}`;
            }
        }
        const cleanLine = logLine.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
        fs.appendFileSync(logFilePath, cleanLine + "\n");

        rotateHighScoreLogs();
    } catch (err) {
        console.error("Failed to write to high score log:", err);
    }
};

/**
 * @deprecated Use logHighScore instead. Retained for backward compatibility.
 */
export const logPermanentHighScore = logHighScore;


const createConsoleLogger = (serviceName: string) => {
    const log = (level: string, message: string, meta?: any) => {
        const timestamp = new Date().toISOString();
        let msg = `${timestamp} [${level.toUpperCase()}] [${serviceName}]: ${message}`;
        
        const collector: CycleLogCollector | undefined = meta?.collector;

        let displayMeta = meta;
        if (meta && typeof meta === "object" && !(meta instanceof Error) && "collector" in meta) {
            const { collector: _, ...rest } = meta;
            displayMeta = Object.keys(rest).length > 0 ? rest : undefined;
        }

        if (displayMeta) {
            if (displayMeta instanceof Error) {
                msg += `\n${displayMeta.stack || displayMeta.message}`;
            } else if (typeof displayMeta === "string") {
                msg += `\n${displayMeta}`;
            } else if (Object.keys(displayMeta).length > 0) {
                msg += ` ${util.inspect(displayMeta, { depth: 4 })}`;
            }
        }

        if (collector) {
            collector.addLog(msg);
        }

        if (level === "error") {
            console.error(msg);
        } else if (level === "warn") {
            console.warn(msg);
        } else {
            console.log(msg);
        }
    };

    return {
        debug: (message: string, meta?: any) => log("debug", message, meta),
        info: (message: string, meta?: any) => log("info", message, meta),
        warn: (message: string, meta?: any) => log("warn", message, meta),
        error: (message: string, meta?: any) => log("error", message, meta)
    };
};

export const tradingCycleErrorLogger = createConsoleLogger("trading-error");
export const marketDetectorLogger = createConsoleLogger("market-detector");
export const skipTradingLogger = createConsoleLogger("skip-trading");
export const tradingCronLogger = createConsoleLogger("trading-cron");
export const configDebugLogger = createConsoleLogger("config-debug");
export const tradesLogger = createConsoleLogger("trades");
export const syncLogger = createConsoleLogger("sync");
export const mtfAllowedLogger = createConsoleLogger("mtf-allowed");
export const placedOrdersLogger = createConsoleLogger("placed-orders");

export const getContextualLogger = (
    logger: ReturnType<typeof createConsoleLogger>,
    context: { cycleId?: string; symbol?: string; tradingBotId?: string; collector?: CycleLogCollector } = {}
) => {
    const wrap = (fn: Function) => (message: string, meta?: any) => {
        if (meta instanceof Error) {
            return fn(message, { ...context, error: meta });
        }
        return fn(message, { ...context, ...meta });
    };

    return {
        debug: wrap(logger.debug),
        info: wrap(logger.info),
        warn: wrap(logger.warn),
        error: wrap(logger.error)
    };
};
