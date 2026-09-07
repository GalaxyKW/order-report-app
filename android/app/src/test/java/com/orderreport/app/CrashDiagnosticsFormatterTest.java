package com.orderreport.app;

import org.junit.Test;

/** Keep the standalone privacy/size checks in the ordinary Gradle test run too. */
public final class CrashDiagnosticsFormatterTest {
    @Test
    public void reportsOmitMessagesAndBoundCausesFramesAndUtf8() {
        CrashDiagnosticsFormatterCheck.main(new String[0]);
    }
}
