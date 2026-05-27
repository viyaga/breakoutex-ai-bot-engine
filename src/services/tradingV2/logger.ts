import winston from "winston";
import { getIstTime } from "../../utils/timeUtils";
import util from "util";

// Standard format for all loggers
const serializeError = (err: any) => {
    if (err instanceof Error) {
        return {
            ...err,
            message: err.message,
            stack: err.stack
        };
    }
    return err;
};

const standardFormat = winston.format.combine(
    winston.format.timestamp({ format: getIstTime }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
);

const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: getIstTime }),
    winston.format.printf(({ timestamp, level, message, stack, service, ...meta }) => {
        const serviceTag = service ? `[${service}]` : '';
        let msg = `${timestamp} ${level}: ${serviceTag} ${message}`;
        if (stack) msg += `\n${stack}`;
        if (Object.keys(meta).length > 0) {
            const sanitizedMeta = Object.fromEntries(
                Object.entries(meta).map(([k, v]) => [k, serializeError(v)])
            );
            msg += ` ${util.inspect(sanitizedMeta, { depth: 4 })}`;
        }
        return msg;
    })
);

const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: getIstTime }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, service, ...meta }) => {
        const serviceTag = service ? `[${service}]` : '';
        let msg = `${timestamp} [${level.toUpperCase()}]: ${serviceTag} ${message}`;
        if (stack) msg += `\n${stack}`;
        if (Object.keys(meta).length > 0) {
            const sanitizedMeta = Object.fromEntries(
                Object.entries(meta).map(([k, v]) => [k, serializeError(v)])
            );
            msg += ` ${util.inspect(sanitizedMeta, { depth: 4 })}`;
        }
        return msg;
    })
);

// Generic logger creator
const createLogger = (
    serviceName: string, 
    fileName: string, 
    level: string = 'info', 
    useConsole: boolean = true,
    maxsize: number = 5242880, // Default 5MB
    maxFiles: number = 5
) => {
    const transports: winston.transport[] = [
        new winston.transports.File({
            filename: `logs/${fileName}`,
            level,
            maxsize,
            maxFiles,
            tailable: true,
            format: fileFormat
        })
    ];

    if (useConsole) {
        transports.push(new winston.transports.Console({
            format: consoleFormat,
            level: 'debug' // Console shows everything up to debug by default
        }));
    }

    return winston.createLogger({
        level,
        format: standardFormat,
        defaultMeta: { service: serviceName },
        transports
    });
};

// Logger instances
export const tradingCycleErrorLogger = createLogger('trading-error', 'error.log', 'error');
export const marketDetectorLogger = createLogger('market-detector', 'market.log', 'info', false, 5242880, 5); // 5MB, 5 files
export const skipTradingLogger = createLogger('skip-trading', 'skip-trading.log', 'info', true, 5242880, 5);
export const tradingCronLogger = createLogger('trading-cron', 'cron.log', 'debug');
export const configDebugLogger = createLogger('config-debug', 'config-debug.log', 'debug', true, 524288, 1); // 0.5MB, 1 file

// New loggers for efficient debugging
export const tradesLogger = createLogger('trades', 'trades.log', 'info', false, 5242880, 5);
export const syncLogger = createLogger('sync', 'sync.log', 'info', false, 5242880, 5);
export const mtfAllowedLogger = createLogger('mtf-allowed', 'mtf-allowed.log', 'info', false, 5242880, 5);

/**
 * Contextual Logger Helper
 * Attaches common metadata to every log call for a specific trading cycle
 */
export const getContextualLogger = (logger: winston.Logger, context: { cycleId?: string, symbol?: string, tradingBotId?: string } = {}) => {
    const wrap = (fn: Function) => (message: string, meta?: any) => {
        if (meta instanceof Error) {
            return fn(message, { ...context, error: meta });
        }
        return fn(message, { ...context, ...meta });
    };

    return {
        debug: wrap(logger.debug.bind(logger)),
        info: wrap(logger.info.bind(logger)),
        warn: wrap(logger.warn.bind(logger)),
        error: wrap(logger.error.bind(logger)),
    };
};

