package com.orderreport.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.VectorDrawable;
import android.os.Build;
import android.util.TypedValue;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** Verifies the packaged launcher/theme resources against each Android resource selector. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {26, 33, 35, 36})
public class LauncherResourcesTest {
    @Test
    public void packagedLauncherHasAdaptiveLayersAndDedicatedMonochrome() {
        Application application = RuntimeEnvironment.getApplication();
        Drawable icon = application.getDrawable(application.getApplicationInfo().icon);
        assertTrue("The manifest icon must resolve to an adaptive launcher icon", icon instanceof AdaptiveIconDrawable);
        AdaptiveIconDrawable adaptive = (AdaptiveIconDrawable) icon;
        assertNotNull(adaptive.getBackground());
        assertNotNull(adaptive.getForeground());

        if (Build.VERSION.SDK_INT >= 33) {
            Drawable monochrome = adaptive.getMonochrome();
            assertNotNull("Android 13 themed icons need a monochrome layer", monochrome);
            assertTrue("Monochrome must remain a transparent vector, not the opaque color artwork",
                    monochrome instanceof VectorDrawable);
            assertNotSame(adaptive.getForeground(), monochrome);
        }
    }

    @Test
    public void windowBackgroundMatchesTheOfflinePageDuringLaunch() {
        Application application = RuntimeEnvironment.getApplication();
        application.setTheme(R.style.AppTheme);
        TypedValue background = new TypedValue();
        assertTrue(application.getTheme().resolveAttribute(android.R.attr.windowBackground, background, true));
        assertEquals(0xFFF5F3EE, background.data);
    }
}
