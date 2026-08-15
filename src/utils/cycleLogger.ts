import fs from "fs";
import path from "path";
import util from "util";

const LOG_DIR = path.join(process.cwd(), "logs");
const MAX_LOG_FILES = 20;
const FILE_PATTERN = /^cycle_\d{8}_\d{6}\.log$/; // matches cycle_YYYYMMDD_HHmmss.log

let activeLogFile: string | null = null;
let originalLog: typeof console.log | null = null;
let originalError: typeof console.error | null = null;
let originalWarn: typeof console.warn | null = null;

/**
 * Starts cycle logging by creating a log file for the current cycle and intercepting console output.
 */
export function startCycleLogging(): void {
    try {
        // Ensure log directory exists
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }

        // Clean up old log files before starting a new one
        rotateLogs();

        // Generate filename using the current timestamp in UTC
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, "0");
        const day = String(now.getUTCDate()).padStart(2, "0");
        const hours = String(now.getUTCHours()).padStart(2, "0");
        const minutes = String(now.getUTCMinutes()).padStart(2, "0");
        const seconds = String(now.getUTCSeconds()).padStart(2, "0");

        const dateStr = `${year}${month}${day}_${hours}${minutes}${seconds}`;
        activeLogFile = path.join(LOG_DIR, `cycle_${dateStr}.log`);

        // Intercept console functions if not already intercepted
        if (!originalLog) {
            originalLog = console.log;
            originalError = console.error;
            originalWarn = console.warn;

            console.log = (...args: any[]) => {
                originalLog!(...args);
                writeToLog(util.format(...args));
            };

            console.error = (...args: any[]) => {
                originalError!(...args);
                writeToLog(util.format(...args));
            };

            console.warn = (...args: any[]) => {
                originalWarn!(...args);
                writeToLog(util.format(...args));
            };
        }
    } catch (err) {
        if (originalError) {
            originalError("Failed to start cycle logging:", err);
        } else {
            console.error("Failed to start cycle logging:", err);
        }
    }
}

/**
 * Ends cycle logging by resetting the active file and restoring original console functions.
 */
export function endCycleLogging(): void {
    activeLogFile = null;
    if (originalLog) {
        console.log = originalLog;
        console.error = originalError!;
        console.warn = originalWarn!;
        originalLog = null;
        originalError = null;
        originalWarn = null;
    }
}

/**
 * Appends text content to the active log file, ensuring no ANSI colors are written.
 */
function writeToLog(text: string): void {
    if (activeLogFile) {
        try {
            // Strip any ANSI color codes if they exist
            const cleanText = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
            fs.appendFileSync(activeLogFile, cleanText + "\n");
        } catch (err) {
            if (originalError) {
                originalError("Failed to write to cycle log:", err);
            }
        }
    }
}

const HIGH_SCORE_LOG_DIR = path.join(process.cwd(), "logs", "high_scores");
const MAX_HIGH_SCORE_LOG_FILES = 10;

/**
 * Returns active cycle log file path.
 */
export function getActiveLogFilePath(): string | null {
    return activeLogFile;
}

/**
 * Rotates log files in HIGH_SCORE_LOG_DIR to retain at most MAX_HIGH_SCORE_LOG_FILES (10).
 * Oldest log files are deleted if total count exceeds MAX_HIGH_SCORE_LOG_FILES.
 */
export function rotateHighScoreLogs(): void {
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
                    if (originalError) {
                        originalError(`Failed to delete old high score log file ${logFiles[i].name}:`, unlinkErr);
                    }
                }
            }
        }
    } catch (err) {
        if (originalError) {
            originalError("Error rotating high score logs:", err);
        }
    }
}

/**
 * Copies the current active normal cycle log file into the high score logs directory (logs/high_scores/).
 * Enforces max 10 files retention in logs/high_scores/.
 */
export function promoteCurrentCycleToHighScore(details?: { symbol?: string; score?: number }): string | null {
    try {
        if (!activeLogFile || !fs.existsSync(activeLogFile)) {
            if (originalError) {
                originalError("Cannot promote cycle to high score: active log file does not exist.");
            }
            return null;
        }

        if (!fs.existsSync(HIGH_SCORE_LOG_DIR)) {
            fs.mkdirSync(HIGH_SCORE_LOG_DIR, { recursive: true });
        }

        const basename = path.basename(activeLogFile, ".log"); // e.g. cycle_20260815_110000
        const symbolTag = details?.symbol ? `_${details.symbol.replace(/[^a-zA-Z0-9]/g, "")}` : "";
        const scoreTag = details?.score !== undefined ? `_score${Math.round(details.score)}` : "";

        const destFileName = `high_score_${basename}${symbolTag}${scoreTag}.log`;
        const destPath = path.join(HIGH_SCORE_LOG_DIR, destFileName);

        // Copy exact normal cycle log file
        fs.copyFileSync(activeLogFile, destPath);

        // Enforce max 10 files rotation
        rotateHighScoreLogs();

        return destPath;
    } catch (err) {
        if (originalError) {
            originalError("Failed to promote cycle log to high score directory:", err);
        }
        return null;
    }
}

/**
 * Retains only the most recent (MAX_LOG_FILES - 1) log files to allow space for the new cycle log.
 */
function rotateLogs(): void {
    try {
        const files = fs.readdirSync(LOG_DIR);
        const logFiles = files
            .filter(f => FILE_PATTERN.test(f))
            .map(f => {
                const filePath = path.join(LOG_DIR, f);
                let time = 0;
                try {
                    time = fs.statSync(filePath).mtimeMs;
                } catch {
                    // fall back to parsing timestamp from name if fs.stat fails
                    const match = f.match(/cycle_(\d{8})_(\d{6})\.log/);
                    if (match) {
                        const dateStr = match[1];
                        const timeStr = match[2];
                        const year = parseInt(dateStr.substring(0, 4), 10);
                        const month = parseInt(dateStr.substring(4, 6), 10) - 1;
                        const day = parseInt(dateStr.substring(6, 8), 10);
                        const hour = parseInt(timeStr.substring(0, 2), 10);
                        const min = parseInt(timeStr.substring(2, 4), 10);
                        const sec = parseInt(timeStr.substring(4, 6), 10);
                        time = Date.UTC(year, month, day, hour, min, sec);
                    }
                }
                return { name: f, path: filePath, time };
            })
            .sort((a, b) => a.time - b.time); // Oldest first

        // Keep at most MAX_LOG_FILES - 1
        const keepCount = MAX_LOG_FILES - 1;
        if (logFiles.length > keepCount) {
            const deleteCount = logFiles.length - keepCount;
            for (let i = 0; i < deleteCount; i++) {
                try {
                    fs.unlinkSync(logFiles[i].path);
                } catch (unlinkErr) {
                    if (originalError) {
                        originalError(`Failed to delete old log file ${logFiles[i].name}:`, unlinkErr);
                    }
                }
            }
        }
    } catch (err) {
        if (originalError) {
            originalError("Error rotating logs:", err);
        } else {
            console.error("Error rotating logs:", err);
        }
    }
}