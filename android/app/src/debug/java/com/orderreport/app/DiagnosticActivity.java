package com.orderreport.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** Debug-only native entry: no MainActivity class loading or WebView creation. */
public final class DiagnosticActivity extends Activity {
    private TextView report;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CrashDiagnostics.markStage(this, "diagnostics_open");
        ScrollView scroll = new ScrollView(this);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        body.setPadding(padding, padding, padding, padding);
        scroll.setBackgroundColor(0xFFF5F3EE);
        scroll.addView(body);

        TextView title = new TextView(this);
        title.setText("报单管家 · 启动诊断");
        title.setTextSize(23);
        title.setTypeface(null, Typeface.BOLD);
        body.addView(title);
        TextView help = new TextView(this);
        help.setText(R.string.diagnostic_help);
        help.setTextSize(16);
        help.setPadding(0, padding / 2, 0, padding / 2);
        body.addView(help);
        addButton(body, "尝试打开主界面", () -> {
            try {
                // A string component keeps MainActivity out of this class's
                // verifier path on devices with a class-loading failure.
                startActivity(new Intent().setClassName(this, "com.orderreport.app.MainActivity"));
            } catch (RuntimeException | LinkageError error) {
                CrashDiagnostics.recordFailure(this, "activity_create", error);
                refreshReport();
                Toast.makeText(this, "启动失败，请复制下方诊断信息", Toast.LENGTH_LONG).show();
            }
        });
        addButton(body, "刷新诊断信息", this::refreshReport);
        addButton(body, "复制诊断信息", () -> {
            refreshReport();
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            try {
                if (clipboard == null) throw new IllegalStateException();
                clipboard.setPrimaryClip(ClipData.newPlainText("报单管家启动诊断", report.getText()));
                Toast.makeText(this, "已复制，请发给维护人员", Toast.LENGTH_SHORT).show();
            } catch (RuntimeException error) {
                Toast.makeText(this, "无法自动复制，可长按下方文字选择复制", Toast.LENGTH_LONG).show();
            }
        });
        report = new TextView(this);
        report.setTextSize(12);
        report.setTypeface(Typeface.MONOSPACE);
        report.setTextIsSelectable(true);
        report.setPadding(0, padding / 2, 0, padding);
        body.addView(report);
        setContentView(scroll);
        // Use APIs present since Android 5 here, independently of MainActivity's
        // system-bar setup. Keep diagnostic controls reachable on edge-to-edge OSes.
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        scroll.requestApplyInsets();
        refreshReport();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshReport();
    }

    private void refreshReport() {
        if (report != null) report.setText(CrashDiagnostics.readReport(this));
    }

    private void addButton(LinearLayout body, String label, Runnable action) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setOnClickListener(ignored -> action.run());
        body.addView(button, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
    }
}
