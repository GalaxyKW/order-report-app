package com.orderreport.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.TextView;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {26, 28, 30, 33, 35, 36})
@LooperMode(LooperMode.Mode.PAUSED)
public class DiagnosticActivityTest {
    @Test
    public void diagnosticsOpenWithoutWebViewOrPreviousExitRecords() {
        assertTrue(RuntimeEnvironment.getApplication() instanceof OrderReportApplication);
        try (ActivityController<DiagnosticActivity> controller = Robolectric.buildActivity(DiagnosticActivity.class)) {
            DiagnosticActivity activity = controller.setup().get();
            StringBuilder text = new StringBuilder();
            inspectNativeViews(activity.findViewById(android.R.id.content), text);
            assertTrue(text.toString().contains("报单管家 · 启动诊断"));
            assertTrue(text.toString().contains("系统退出原因"));
            assertTrue(text.toString().contains("尚无可读取的 Java 异常记录"));
            assertFalse(activity.isFinishing());
        }
    }

    private static void inspectNativeViews(View view, StringBuilder text) {
        assertFalse("The diagnostic entry must not instantiate a WebView", view instanceof WebView);
        if (view instanceof TextView) text.append(((TextView) view).getText()).append('\n');
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                inspectNativeViews(group.getChildAt(index), text);
            }
        }
    }
}
