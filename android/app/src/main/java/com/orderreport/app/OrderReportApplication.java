package com.orderreport.app;

import android.app.Application;

public final class OrderReportApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        CrashDiagnostics.install(this);
    }
}
