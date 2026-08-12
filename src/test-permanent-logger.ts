import fs from "fs";
import path from "path";
import {
    logHighScore,
    logPermanentHighScore,
    getHighScoreLogPath,
    rotateHighScoreLogs,
    HIGH_SCORE_LOG_DIR,
    MAX_HIGH_SCORE_LOG_FILES
} from "./services/tradingV2/logger";

async function testHighScoreLogger() {
    console.log("=== TESTING HIGH SCORE LOGGER & MAX 10 FILES ROTATION ===");

    // Test 1: Logging a high score entry
    const testMessage = "[TEST-LOG] Symbol: ETHUSD | BotID: test_bot_99 | FinalScore: 72.0 (Entry: 75, Conf: 70, Struct: 70) | Direction: BUY | Allowed: true";
    logPermanentHighScore(testMessage);

    const logFile = getHighScoreLogPath();
    console.log("\n[Test 1] Current High Score Log File:", logFile);

    if (!fs.existsSync(logFile)) {
        console.error("❌ Test 1 FAILED: High score log file was not created!");
        process.exit(1);
    }

    const content = fs.readFileSync(logFile, "utf-8");
    if (!content.includes("FinalScore: 72.0")) {
        console.error("❌ Test 1 FAILED: Log content missing test message!");
        process.exit(1);
    }
    console.log("✅ [Test 1] High score log file created and verified successfully!");

    // Test 2: Rotation limit test (Create 15 dummy log files in HIGH_SCORE_LOG_DIR and verify max 10 retained)
    console.log("\n[Test 2] Testing log file rotation limit (max 10 files)...");
    
    // Ensure directory exists
    if (!fs.existsSync(HIGH_SCORE_LOG_DIR)) {
        fs.mkdirSync(HIGH_SCORE_LOG_DIR, { recursive: true });
    }

    // Clean directory first for clean test state
    const existing = fs.readdirSync(HIGH_SCORE_LOG_DIR);
    for (const file of existing) {
        fs.unlinkSync(path.join(HIGH_SCORE_LOG_DIR, file));
    }

    // Create 15 dummy files with distinct modified times
    const now = Date.now();
    for (let i = 1; i <= 15; i++) {
        const dummyPath = path.join(HIGH_SCORE_LOG_DIR, `dummy_log_${String(i).padStart(2, "0")}.log`);
        fs.writeFileSync(dummyPath, `Dummy log ${i}\n`);
        // Set distinct modified time (i seconds ago)
        const fileTime = new Date(now + i * 1000);
        fs.utimesSync(dummyPath, fileTime, fileTime);
    }

    let filesBefore = fs.readdirSync(HIGH_SCORE_LOG_DIR);
    console.log(`  Created ${filesBefore.length} test files in ${HIGH_SCORE_LOG_DIR}`);

    // Trigger rotation
    rotateHighScoreLogs();

    let filesAfter = fs.readdirSync(HIGH_SCORE_LOG_DIR);
    console.log(`  Files remaining after rotation: ${filesAfter.length} (Max allowed: ${MAX_HIGH_SCORE_LOG_FILES})`);

    if (filesAfter.length !== 10) {
        console.error(`❌ Test 2 FAILED: Expected 10 files remaining, found ${filesAfter.length}`);
        process.exit(1);
    }

    // Verify oldest files (dummy_log_01 to dummy_log_05) were deleted and newest (06 to 15) retained
    if (filesAfter.includes("dummy_log_01.log") || filesAfter.includes("dummy_log_05.log")) {
        console.error("❌ Test 2 FAILED: Oldest files were not deleted during rotation!");
        process.exit(1);
    }

    if (!filesAfter.includes("dummy_log_15.log") || !filesAfter.includes("dummy_log_06.log")) {
        console.error("❌ Test 2 FAILED: Newest files were deleted unexpectedly!");
        process.exit(1);
    }

    console.log("✅ [Test 2] Max 10 files rotation verified successfully!");

    // Clean up dummy test files and log a fresh high score
    for (const file of filesAfter) {
        fs.unlinkSync(path.join(HIGH_SCORE_LOG_DIR, file));
    }
    logHighScore(testMessage);

    console.log("\n✅ ALL HIGH SCORE LOGGER TESTS PASSED SUCCESSFULLY!");
}

testHighScoreLogger();
