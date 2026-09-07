package com.orderreport.app;

import android.app.Application;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.AtomicFile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.IdentityHashMap;
import java.util.List;

/** Local diagnostics only: never records exception messages, business data or URLs. */
public final class CrashDiagnostics {
    private static final int MAX_BYTES = 16 * 1024;
    private static final String FAILURE_FILE = "crash-diagnostics.txt";
    private static final String CURRENT_STAGE_FILE = "crash-startup-stage.txt";
    private static final String PREVIOUS_STAGE_FILE = "crash-previous-stage.txt";
    private static final Object LOCK = new Object();
    private static boolean installed;
    private static volatile StageSnapshot currentStage;
    private static volatile StageSnapshot previousStage;

    private CrashDiagnostics() {}

    public static void install(Application application) {
        synchronized (LOCK) {
            if (installed) return;
            final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
            try {
                Thread.setDefaultUncaughtExceptionHandler((thread, failure) -> {
                    try {
                        // Avoid allocating a diagnostic buffer during a VM memory failure.
                        // Other failures while reporting still reach the system handler.
                        if (!(failure instanceof OutOfMemoryError)) {
                            recordFailure(application, "uncaught_exception", failure);
                        }
                    } finally {
                        if (previous != null) {
                            previous.uncaughtException(thread, failure);
                        } else {
                            // Android normally installs a handler. Without one, do not
                            // accidentally leave a broken process running after a fatal error.
                            android.os.Process.killProcess(android.os.Process.myPid());
                            System.exit(10);
                        }
                    }
                });
                installed = true;
            } catch (RuntimeException ignored) {
                // A diagnostics setup failure must not prevent normal application startup.
            }

            StageSnapshot saved = readStage(application, CURRENT_STAGE_FILE);
            StageSnapshot retained = readStage(application, PREVIOUS_STAGE_FILE);
            // Opening diagnostics starts Application too. Do not let that application-only
            // session replace the last useful main-page stage after a native process crash.
            previousStage = isUsefulPreviousStage(saved) ? saved : retained != null ? retained : saved;
            if (isUsefulPreviousStage(saved)) writeStage(application, PREVIOUS_STAGE_FILE, saved);
            markStage(application, "application_create");
        }
    }

    public static void markStage(Context context, String stage) {
        StageSnapshot snapshot = new StageSnapshot(System.currentTimeMillis(), normalizeStage(stage));
        synchronized (LOCK) {
            currentStage = snapshot;
            // This screen describes a previous failure; merely opening it is not another
            // attempted main-page startup and must not erase its persisted stage.
            if (!"diagnostics_open".equals(snapshot.stage)) {
                writeStage(context, CURRENT_STAGE_FILE, snapshot);
            }
        }
    }

    public static void recordFailure(Context context, String phase, Throwable failure) {
        if (failure == null || failure instanceof OutOfMemoryError) return;
        try {
            StageSnapshot snapshot = currentStage;
            String report = ReportFormatter.formatFailure(
                    System.currentTimeMillis(), deviceDescription(context),
                    snapshot == null ? "unknown" : snapshot.stage, normalizeStage(phase), failure);
            synchronized (LOCK) {
                writeAtomic(context, FAILURE_FILE, report);
            }
        } catch (RuntimeException ignored) {
            // A missing/unavailable private data directory or unusual Throwable must not
            // hide the original error or introduce a second startup failure.
        }
    }

    public static String readReport(Context context) {
        StringBuilder report = new StringBuilder();
        report.append("报单管家本地启动诊断\n").append(deviceDescription(context)).append('\n');
        report.append("仅含版本、启动阶段和异常栈位置，不含订单、令牌或服务器地址。\n\n");
        StageSnapshot previous = previousStage;
        if (previous == null) previous = readStage(context, PREVIOUS_STAGE_FILE);
        appendStage(report, "上一主页面启动最后阶段", previous);
        appendStage(report, "本次进程当前阶段", currentStage);
        report.append('\n');
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            report.append(Api30.readExitReasons(context));
        } else {
            report.append("系统退出原因：Android 11 以下不提供此接口。\n");
        }
        report.append("\n最近一次 Java 异常记录（可能属于更早的一次运行）：\n");
        String failure;
        synchronized (LOCK) {
            failure = readAtomic(context, FAILURE_FILE);
        }
        report.append(failure == null ? "尚无可读取的 Java 异常记录。\n" : failure);
        return ReportFormatter.limitUtf8(report.toString());
    }

    private static String deviceDescription(Context context) {
        String version = "未知";
        try {
            @SuppressWarnings("deprecation")
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            version = ReportFormatter.singleLine(info.versionName, 80) + " (" + info.versionCode + ")";
        } catch (PackageManager.NameNotFoundException | RuntimeException ignored) {
            // Metadata is optional; the recovery screen must still work if it is unavailable.
        }
        return "应用版本：" + version + "\nAndroid："
                + ReportFormatter.singleLine(Build.VERSION.RELEASE, 80) + " / API " + Build.VERSION.SDK_INT
                + "\n设备：" + ReportFormatter.singleLine(Build.MANUFACTURER, 100) + " "
                + ReportFormatter.singleLine(Build.MODEL, 100);
    }

    private static boolean isUsefulPreviousStage(StageSnapshot snapshot) {
        return snapshot != null && !"application_create".equals(snapshot.stage)
                && !"diagnostics_open".equals(snapshot.stage) && !"unknown".equals(snapshot.stage);
    }

    private static String normalizeStage(String value) {
        if (value == null) return "unknown";
        switch (value) {
            case "application_create":
            case "activity_create":
            case "system_bars":
            case "content_view":
            case "window_insets":
            case "webview_start":
            case "webview_configure":
            case "webview_load":
            case "export_restore":
            case "back_callback":
            case "page_ready":
            case "webview_recovery":
            case "diagnostics_open":
            case "uncaught_exception":
            case "cleanup":
            case "back_navigation":
            case "save_navigation_state":
            case "printing":
                return value;
            default:
                return "unknown";
        }
    }

    private static void appendStage(StringBuilder report, String label, StageSnapshot snapshot) {
        report.append(label).append("：");
        if (snapshot == null) report.append("无记录\n");
        else report.append(snapshot.stage).append("；时间戳(ms)：").append(snapshot.timestamp).append('\n');
    }

    private static StageSnapshot readStage(Context context, String name) {
        String text = readAtomic(context, name);
        if (text == null) return null;
        String[] parts = text.split("\n", 3);
        if (parts.length < 2) return null;
        try {
            long timestamp = Long.parseLong(parts[0]);
            String stage = normalizeStage(parts[1]);
            return timestamp > 0 && !"unknown".equals(stage) ? new StageSnapshot(timestamp, stage) : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static void writeStage(Context context, String name, StageSnapshot snapshot) {
        writeAtomic(context, name, snapshot.timestamp + "\n" + snapshot.stage + "\n");
    }

    private static AtomicFile atomicFile(Context context, String name) {
        File directory = context.getFilesDir();
        if (directory == null) throw new IllegalStateException("Private files unavailable");
        return new AtomicFile(new File(directory, name));
    }

    private static void writeAtomic(Context context, String name, String text) {
        AtomicFile file = null;
        FileOutputStream stream = null;
        try {
            byte[] bytes = ReportFormatter.limitUtf8(text).getBytes(StandardCharsets.UTF_8);
            file = atomicFile(context, name);
            stream = file.startWrite();
            stream.write(bytes);
            file.finishWrite(stream);
        } catch (IOException | RuntimeException ignored) {
            if (file != null && stream != null) {
                try {
                    file.failWrite(stream);
                } catch (RuntimeException ignoredCleanup) {
                    // Best-effort reporting must never mask the original failure.
                }
            }
        }
    }

    private static String readAtomic(Context context, String name) {
        try (FileInputStream input = atomicFile(context, name).openRead();
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int remaining = MAX_BYTES;
            int count;
            while (remaining > 0 && (count = input.read(buffer, 0, Math.min(buffer.length, remaining))) != -1) {
                output.write(buffer, 0, count);
                remaining -= count;
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException | RuntimeException ignored) {
            return null;
        }
    }

    private static final class StageSnapshot {
        final long timestamp;
        final String stage;

        StageSnapshot(long timestamp, String stage) {
            this.timestamp = timestamp;
            this.stage = stage;
        }
    }

    /** Isolated so pre-30 Android never needs to resolve ApplicationExitInfo. */
    private static final class Api30 {
        static String readExitReasons(Context context) {
            // Keep the precondition visible here as well as at the caller so
            // static API checks and any future caller retain the same boundary.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                return "系统退出原因：Android 11 以下不提供此接口。\n";
            }
            try {
                android.app.ActivityManager manager =
                        (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                if (manager == null) return "系统退出原因：系统服务不可用。\n";
                List<android.app.ApplicationExitInfo> history = manager.getHistoricalProcessExitReasons(
                        context.getPackageName(), 0, 3);
                if (history.isEmpty()) return "系统退出原因：尚无本应用的历史记录。\n";
                StringBuilder result = new StringBuilder("最近系统退出记录（本应用，最多3条）：\n");
                for (int index = 0; index < Math.min(3, history.size()); index++) {
                    android.app.ApplicationExitInfo info = history.get(index);
                    result.append("reason=").append(info.getReason()).append(", status=")
                            .append(info.getStatus()).append(", timestamp(ms)=")
                            .append(info.getTimestamp()).append('\n');
                }
                // Deliberately never read description, trace streams, process names or extras.
                return result.toString();
            } catch (RuntimeException ignored) {
                return "系统退出原因：暂时无法读取。\n";
            }
        }
    }

    /** Pure Java formatter, independently testable without running Android. */
    static final class ReportFormatter {
        private static final int MAX_CAUSES = 8;
        private static final int MAX_FRAMES = 40;

        static String formatFailure(long timestamp, String metadata, String stage, String phase, Throwable error) {
            StringBuilder result = new StringBuilder();
            result.append("记录时间戳(ms)：").append(timestamp).append('\n').append(metadata).append('\n');
            result.append("最后启动阶段：").append(stage).append("\n异常发生阶段：").append(phase).append('\n');
            IdentityHashMap<Throwable, Boolean> seen = new IdentityHashMap<>();
            int frames = 0;
            int depth = 0;
            for (Throwable current = error; current != null && depth < MAX_CAUSES; current = current.getCause()) {
                if (seen.put(current, Boolean.TRUE) != null) {
                    result.append("[重复的异常原因已省略]\n");
                    break;
                }
                result.append(depth++ == 0 ? "exception=" : "cause=")
                        .append(singleLine(current.getClass().getName(), 240)).append('\n');
                for (StackTraceElement frame : current.getStackTrace()) {
                    if (frames >= MAX_FRAMES) break;
                    result.append("  at ").append(singleLine(frame.getClassName(), 240)).append('.')
                            .append(singleLine(frame.getMethodName(), 160)).append('(')
                            .append(singleLine(frame.getFileName(), 160)).append(':')
                            .append(frame.getLineNumber()).append(")\n");
                    frames++;
                }
            }
            if (depth >= MAX_CAUSES || frames >= MAX_FRAMES) result.append("[异常原因/栈帧已限制长度]\n");
            return limitUtf8(result.toString());
        }

        static String singleLine(String value, int maxCharacters) {
            if (value == null) return "unknown";
            StringBuilder cleaned = new StringBuilder();
            for (int index = 0; index < Math.min(value.length(), maxCharacters); index++) {
                char character = value.charAt(index);
                cleaned.append(Character.isISOControl(character) ? ' ' : character);
            }
            return cleaned.toString();
        }

        static String limitUtf8(String text) {
            byte[] encoded = text.getBytes(StandardCharsets.UTF_8);
            if (encoded.length <= MAX_BYTES) return text;
            String suffix = "\n[报告已截断]\n";
            int end = MAX_BYTES - suffix.getBytes(StandardCharsets.UTF_8).length;
            while (end > 0 && (encoded[end] & 0xc0) == 0x80) end--;
            return new String(encoded, 0, end, StandardCharsets.UTF_8) + suffix;
        }
    }
}
