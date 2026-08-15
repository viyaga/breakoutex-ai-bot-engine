import fs from "fs";
import path from "path";
import {
    logHighScore,
    logPermanentHighScore,
    rotateHighScoreLogs,
    HIGH_SCORE_LOG_DIR,
    MAX_HIGH_SCORE_LOG_FILES
} from "./services/tradingV2/logger";
import {
    startCycleLogging,
    endCycleLogging,
    promoteCurrentCycleToHighScore,
    getActiveLogFilePath
} from "./utils/cycleLogger";

async function testHighScoreLogger() {
    console.log("=== TESTING HIGH SCORE LOGGER & MAX 10 FILES ROTATION ===");

    // Clean high_scores directory first
    if (!fs.existsSync(HIGH_SCORE_LOG_DIR)) {
        fs.mkdirSync(HIGH_SCORE_LOG_DIR, { recursive: true });
    }
    const initFiles = fs.readdirSync(HIGH_SCORE_LOG_DIR);
    for (const f of initFiles) {
        fs.unlinkSync(path.join(HIGH_SCORE_LOG_DIR, f));
    }

    // Test 1: Promoting an active normal cycle log file to high scores
    console.log("\n[Test 1] Testing normal cycle log promotion to high scores...");
    startCycleLogging();

    const testConsoleMessage = "[CYCLE LOG MSG] 2026-08-15 - Processing MTF analysis for BTCUSD with high score 85";
    console.log(testConsoleMessage);

    const activeFile = getActiveLogFilePath();
    if (!activeFile || !fs.existsSync(activeFile)) {
        console.error("❌ Test 1 FAILED: Active normal log file was not created!");
        process.exit(1);
    }

    const promotedPath = promoteCurrentCycleToHighScore({ symbol: "BTCUSD", score: 85 });
    endCycleLogging();

    if (!promotedPath || !fs.existsSync(promotedPath)) {
        console.error("❌ Test 1 FAILED: High score promoted log file was not created!");
        process.exit(1);
    }

    const content = fs.readFileSync(promotedPath, "utf-8");
    if (!content.includes(testConsoleMessage)) {
        console.error("❌ Test 1 FAILED: Promoted high score log does not contain exact normal log output!");
        process.exit(1);
    }

    console.log(`✅ [Test 1] Exact normal log file successfully copied to high score: ${path.basename(promotedPath)}`);

    // Test 2: Rotation limit test (Create 15 dummy log files in HIGH_SCORE_LOG_DIR and verify max 10 retained)
    console.log("\n[Test 2] Testing log file rotation limit (max 10 files)...");
    
    // Clean directory for rotation test
    const existing = fs.readdirSync(HIGH_SCORE_LOG_DIR);
    for (const file of existing) {
        fs.unlinkSync(path.join(HIGH_SCORE_LOG_DIR, file));
    }

    // Create 15 dummy files with distinct modified times
    const now = Date.now();
    for (let i = 1; i <= 15; i++) {
        const dummyPath = path.join(HIGH_SCORE_LOG_DIR, `high_score_dummy_${String(i).padStart(2, "0")}.log`);
        fs.writeFileSync(dummyPath, `Dummy log ${i}\n`);
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

    // Verify oldest files (dummy_01 to dummy_05) were deleted and newest (06 to 15) retained
    if (filesAfter.includes("high_score_dummy_01.log") || filesAfter.includes("high_score_dummy_05.log")) {
        console.error("❌ Test 2 FAILED: Oldest files were not deleted during rotation!");
        process.exit(1);
    }

    if (!filesAfter.includes("high_score_dummy_15.log") || !filesAfter.includes("high_score_dummy_06.log")) {
        console.error("❌ Test 2 FAILED: Newest files were deleted unexpectedly!");
        process.exit(1);
    }

    console.log("✅ [Test 2] Max 10 files rotation verified successfully!");
    console.log("\n✅ ALL HIGH SCORE LOGGER TESTS PASSED SUCCESSFULLY!");
}

testHighScoreLogger();

