package com.orderreport.app;

import java.nio.charset.StandardCharsets;

/** Standalone JVM checks; no device, Android runtime or business fixture is needed. */
public final class CrashDiagnosticsFormatterCheck {
    public static void main(String[] args) {
        String secret = "TOKEN-PRIVATE https://private.example/order?id=123";
        IllegalStateException error = new IllegalStateException(secret, new IllegalArgumentException(secret));
        String report = format(error);
        require(!report.contains(secret) && !report.contains("private.example"), "exception messages leaked");
        require(report.contains("java.lang.IllegalStateException") && report.contains("java.lang.IllegalArgumentException"),
                "exception classes missing");

        Throwable chain = null;
        for (int index = 0; index < 12; index++) {
            Throwable next = new RuntimeException(secret, chain);
            StackTraceElement[] frames = new StackTraceElement[20];
            for (int frame = 0; frame < frames.length; frame++) {
                frames[frame] = new StackTraceElement("com.example.Test", "execute", "Test.java", frame);
            }
            next.setStackTrace(frames);
            chain = next;
        }
        report = format(chain);
        require(count(report, "  at ") == 40, "stack frame limit not enforced");
        require(count(report, "exception=") + count(report, "cause=") == 8, "cause limit not enforced");

        Exception first = new Exception(secret);
        Exception second = new Exception(secret);
        first.initCause(second);
        second.initCause(first);
        report = format(first);
        require(report.contains("重复的异常原因"), "cause cycle was not detected");

        String bounded = CrashDiagnostics.ReportFormatter.limitUtf8("汉🙂".repeat(10000));
        require(bounded.getBytes(StandardCharsets.UTF_8).length <= 16 * 1024, "UTF-8 byte limit exceeded");
        require(!bounded.contains("\uFFFD"), "UTF-8 character was split during truncation");
        require(!CrashDiagnostics.ReportFormatter.singleLine("foo\nbar\txyz", 20).contains("\n"),
                "metadata contains unexpected newlines");
        System.out.println("Crash diagnostics formatter checks passed");
    }

    private static String format(Throwable error) {
        return CrashDiagnostics.ReportFormatter.formatFailure(123L, "app=0.1.2", "system_bars", "uncaught_exception", error);
    }

    private static int count(String value, String token) {
        int matches = 0;
        int offset = 0;
        while ((offset = value.indexOf(token, offset)) >= 0) {
            matches++;
            offset += token.length();
        }
        return matches;
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
