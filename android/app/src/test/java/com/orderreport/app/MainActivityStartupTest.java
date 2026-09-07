package com.orderreport.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import java.io.File;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

/**
 * Executes the actual Activity lifecycle against Android framework implementations
 * and the packaged manifest/theme. WebView is a Robolectric shadow: these tests do
 * not claim to execute Chromium, JavaScript or a manufacturer's WebView provider.
 * SDK 36 requires the test JVM to run on JDK 21 (the app still compiles to Java 17).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {26, 28, 30, 33, 35, 36})
@LooperMode(LooperMode.Mode.PAUSED)
public class MainActivityStartupTest {
    @Before
    public void resetExportCoordinatorAndTestPreferences() throws Exception {
        // Robolectric may reuse a sandbox for tests at the same API level.
        // Reset this process-wide coordinator so every test exercises disk load.
        Field exportsField = MainActivity.class.getDeclaredField("EXPORTS");
        exportsField.setAccessible(true);
        Object exports = exportsField.get(null);
        setField(exports, "loaded", false);
        setField(exports, "recoveryBlocked", false);
        setField(exports, "activeJobId", 0L);
        setField(exports, "pendingResult", null);
        setField(exports, "deliveringResultId", 0L);
        setField(exports, "pickerDispatchPending", false);
        setField(exports, "activityReference", new WeakReference<MainActivity>(null));
        setField(exports, "resultActivityReference", new WeakReference<MainActivity>(null));
        RuntimeEnvironment.getApplication()
                .getSharedPreferences("native-export-state", Context.MODE_PRIVATE)
                .edit().clear().commit();
    }

    @Test
    public void coldStartCreatesWebViewAndDestroysItCleanly() {
        WebView webView;
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity activity = controller.setup().get();
            webView = requireWebView(activity);
            assertTrue(webView.getUrl().startsWith("file:///android_asset/index.html"));
            assertTrue(webView.getSettings().getJavaScriptEnabled());
            assertTrue(webView.getSettings().getDomStorageEnabled());
            assertFalse(activity.isFinishing());
        }
        assertTrue(Shadows.shadowOf(webView).wasDestroyCalled());
    }

    @Test
    public void savedNavigationSurvivesActivityRecreation() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity original = controller.setup().get();
            WebView first = requireWebView(original);
            String restoredUrl = first.getUrl() + "#startup-test";
            Shadows.shadowOf(first).pushEntryToHistory(restoredUrl);

            controller.recreate();

            assertNotSame(original, controller.get());
            assertTrue(Shadows.shadowOf(first).wasDestroyCalled());
            WebView restored = requireWebView(controller.get());
            assertNotSame(first, restored);
            assertEquals(restoredUrl, restored.getUrl());
        }
    }

    @Test
    public void malformedPersistedExportJobMustNotCrashStartup() throws Exception {
        Context application = RuntimeEnvironment.getApplication();
        File retained = File.createTempFile("order-report-export-recovery-test-", ".json", application.getCacheDir());
        byte[] recoveryContent = "{\"recoveryTest\":true}".getBytes(StandardCharsets.UTF_8);
        Files.write(retained.toPath(), recoveryContent);
        assertTrue(retained.setLastModified(System.currentTimeMillis() - 3L * 24 * 60 * 60 * 1000));
        SharedPreferences preferences = application.getSharedPreferences("native-export-state", Context.MODE_PRIVATE);
        assertTrue(preferences.edit().putString("jobId", "invalid-job-id")
                .putString("stage", "copying").putString("cacheName", retained.getName()).commit());
        Map<String, ?> originalPreferences = new HashMap<>(preferences.getAll());
        // This is deliberately an ordinary startup assertion, not an expected
        // exception: a ClassCastException from preferences must fail the test.
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            WebView webView = requireWebView(controller.setup().get());
            assertEquals(originalPreferences, preferences.getAll());
            assertTrue(retained.isFile());

            Object bridge = Shadows.shadowOf(webView).getJavascriptInterface("AndroidBridge");
            assertNotNull(bridge);
            Method saveText = bridge.getClass().getDeclaredMethod("saveText", String.class, String.class);
            saveText.setAccessible(true);
            saveText.invoke(bridge, "should-not-overwrite-recovery.json", "{}");
            assertEquals("Blocked export must not replace the original preference values", originalPreferences, preferences.getAll());

            controller.recreate();
            controller.newIntent(new Intent(application, MainActivity.class));
            requireWebView(controller.get());
            assertEquals(originalPreferences, preferences.getAll());
            assertTrue("Stale export cleanup must preserve recovery files", retained.isFile());
            assertEquals(new String(recoveryContent, StandardCharsets.UTF_8),
                    new String(Files.readAllBytes(retained.toPath()), StandardCharsets.UTF_8));
        }
    }

    private static WebView requireWebView(MainActivity activity) {
        WebView webView = findWebView(activity.findViewById(android.R.id.content));
        assertNotNull("The app must launch its WebView, not silently fall back to an error screen", webView);
        return webView;
    }

    private static WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                WebView child = findWebView(group.getChildAt(index));
                if (child != null) return child;
            }
        }
        return null;
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }
}
