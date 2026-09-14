package com.orderreport.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.InputStream;
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
    @SuppressWarnings("deprecation")
    public void versionedOfflineAssetsKeepTheirOriginAndDefaultResourceLoader() throws Exception {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity activity = controller.setup().get();
            WebView webView = requireWebView(activity);
            Uri entry = Uri.parse(webView.getUrl());
            assertEquals("file", entry.getScheme());
            assertEquals("/android_asset/index.html", entry.getPath());
            WebViewClient client = webView.getWebViewClient();
            assertNotNull(client);

            for (String name : new String[] {"client.js", "compat.js", "styles.css"}) {
                Uri asset = Uri.parse("file:///android_asset/" + name + "?v=11");
                assertEquals("/android_asset/" + name, asset.getPath());
                assertEquals("v=11", asset.getQuery());
                // The query is metadata, not part of an AssetManager filename.
                try (InputStream stream = activity.getAssets().open(
                        asset.getPath().substring("/android_asset/".length()))) {
                    assertTrue("The bundled versioned resource must exist", stream.read() >= 0);
                }
                WebResourceRequest request = resourceRequest(asset);
                assertNull("Subresources must use WebView's built-in file/asset loader",
                        client.shouldInterceptRequest(webView, request));
                assertNull(client.shouldInterceptRequest(webView, asset.toString()));
                assertEquals("Cache-busting must not alter the existing navigation policy",
                        client.shouldOverrideUrlLoading(webView, "file:///android_asset/" + name),
                        client.shouldOverrideUrlLoading(webView, asset.toString()));
                assertFalse("Versioned assets must remain inside the permitted local origin",
                        client.shouldOverrideUrlLoading(webView, asset.toString()));
                assertEquals(client.shouldOverrideUrlLoading(webView, asset.toString()),
                        client.shouldOverrideUrlLoading(webView, request));
            }
            assertEquals("Resource requests must not navigate away from the existing local origin",
                    entry.toString(), webView.getUrl());
        }
    }

    @Test
    @SuppressWarnings("deprecation")
    public void localNavigationAcceptsEmptyAuthoritiesButRejectsExternalAndEscapedPaths() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            WebView webView = requireWebView(controller.setup().get());
            WebViewClient client = webView.getWebViewClient();
            assertNotNull(client);
            for (String allowed : new String[] {
                    "file:///android_asset/index.html?nativeInsets=1#reports",
                    "file:///android_asset/client.js?v=11",
                    "file:/android_asset/index.html?nativeInsets=1#reports",
                    "file:///android_asset/icons/app-icon.png"
            }) {
                assertFalse(allowed, client.shouldOverrideUrlLoading(webView, allowed));
                assertFalse(allowed, client.shouldOverrideUrlLoading(webView,
                        resourceRequest(Uri.parse(allowed))));
            }
            for (String blocked : new String[] {
                    "https://example.test/android_asset/index.html",
                    "http://example.test/android_asset/index.html",
                    "content://example.test/android_asset/index.html",
                    "javascript:alert(1)",
                    "file://host/android_asset/index.html",
                    "file://user@host/android_asset/index.html",
                    "file://host:8080/android_asset/index.html",
                    "file://%68ost/android_asset/index.html",
                    "file:///data/local/tmp/index.html",
                    "file:///android_asset_suffix/index.html",
                    "file:///android_asset/../outside.html",
                    "file:///android_asset/./client.js",
                    "file:///android_asset/%2e%2e/outside.html",
                    "file:///android_asset/%2E/client.js",
                    "file:///android_asset/icons/%2e%2e/client.js",
                    "file:///android_asset/%2f../outside.html",
                    "file:///android_asset/%5c..%5coutside.html",
                    "file:///android_asset/icons\\..\\client.js",
                    "file:///android_asset/%252e%252e/outside.html",
                    "file:///android_asset/client.js%00outside.html"
            }) {
                assertTrue(blocked, client.shouldOverrideUrlLoading(webView, blocked));
                assertTrue(blocked, client.shouldOverrideUrlLoading(webView,
                        resourceRequest(Uri.parse(blocked))));
            }
        }
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

    private static WebResourceRequest resourceRequest(Uri uri) {
        return new WebResourceRequest() {
            @Override public Uri getUrl() { return uri; }
            @Override public boolean isForMainFrame() { return false; }
            @Override public boolean isRedirect() { return false; }
            @Override public boolean hasGesture() { return false; }
            @Override public String getMethod() { return "GET"; }
            @Override public Map<String, String> getRequestHeaders() { return new HashMap<>(); }
        };
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
