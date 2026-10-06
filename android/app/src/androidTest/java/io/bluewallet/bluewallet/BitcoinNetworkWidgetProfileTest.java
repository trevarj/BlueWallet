package io.bluewallet.bluewallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeFalse;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.net.Uri;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.List;
import java.util.concurrent.TimeUnit;

@RunWith(AndroidJUnit4.class)
public class BitcoinNetworkWidgetProfileTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void widgetComponentsFollowTheImmutableBuildProfile() throws Exception {
        assertTrue(BuildConfig.BITCOIN_NETWORK.equals("bitcoin") || BuildConfig.BITCOIN_NETWORK.equals("testnet4"));
        boolean mainnet = BuildConfig.BITCOIN_NETWORK.equals("bitcoin");
        PackageManager packageManager = context.getPackageManager();
        int flags = PackageManager.MATCH_DISABLED_COMPONENTS;

        ActivityInfo priceWidget = packageManager.getReceiverInfo(new ComponentName(context, BitcoinPriceWidget.class), flags);
        ActivityInfo marketWidget = packageManager.getReceiverInfo(new ComponentName(context, MarketWidget.class), flags);
        ActivityInfo marketConfiguration = packageManager.getActivityInfo(new ComponentName(context, MarketWidgetConfigureActivity.class), flags);

        assertEquals(mainnet, priceWidget.enabled);
        assertEquals(mainnet, marketWidget.enabled);
        assertEquals(mainnet, marketConfiguration.enabled);
        assertEquals(mainnet, AppWidgetUtils.INSTANCE.isWidgetAvailable(context));
    }

    @Test
    public void installedIdentityAndOwnedLinksFollowTheChainProfile() throws Exception {
        boolean mainnet = BuildConfig.BITCOIN_NETWORK.equals("bitcoin");
        String packageName = mainnet ? "io.bluewallet.bluewallet.bhwi" : "io.bluewallet.bluewallet.bhwi.testnet4";
        String scheme = mainnet ? "bluewallet-bhwi" : "bluewallet-bhwi-testnet4";
        String foreignScheme = mainnet ? "bluewallet-bhwi-testnet4" : "bluewallet-bhwi";
        assertEquals(packageName, context.getPackageName());
        PackageManager packageManager = context.getPackageManager();
        String releaseLabel = mainnet ? "BHWI PoC" : "BHWI PoC Testnet4";
        assertEquals(BuildConfig.DEBUG ? "Bluewallet (bhwi debug)" : releaseLabel,
                packageManager.getApplicationLabel(context.getApplicationInfo()).toString());
        assertEquals(mainnet ? "BHWI PoC Settings" : "BHWI PoC Testnet4 Settings", context.getString(R.string.app_settings_name));
        ProviderInfo provider = packageManager.resolveContentProvider(packageName + ".provider", 0);
        assertTrue(provider != null);
        assertFalse(provider.exported);
        Intent owned = new Intent(Intent.ACTION_VIEW, Uri.parse(scheme + ":setelectrumserver?server=profile.invalid:443:s"));
        owned.setPackage(packageName);
        assertFalse(packageManager.queryIntentActivities(owned, 0).isEmpty());
        for (String foreign : new String[] {foreignScheme, "bluewallet-bhwi-testnet"}) {
            Intent rejected = new Intent(Intent.ACTION_VIEW, Uri.parse(foreign + ":setelectrumserver?server=foreign.invalid:443:s"));
            rejected.setPackage(packageName);
            assertTrue(packageManager.queryIntentActivities(rejected, 0).isEmpty());
        }
    }

    @Test
    public void testnetSchedulingBoundariesLeaveNoRunnableWidgetWork() throws Exception {
        assumeFalse(BuildConfig.BITCOIN_NETWORK.equals("bitcoin"));

        WidgetUpdateWorker.Companion.scheduleWork(context);
        WidgetUpdateWorker.Companion.scheduleImmediateUpdate(context);
        WidgetUpdateWorker.Companion.scheduleRetryOnNetworkAvailable(context);
        MarketWidgetUpdateWorker.Companion.scheduleMarketUpdate(context, true);
        MarketWidgetUpdateWorker.Companion.scheduleRetryOnNetworkAvailable(context);

        assertNoRunnableWork(WidgetUpdateWorker.WORK_NAME);
        assertNoTaggedWork(WidgetUpdateWorker.TAG);
        assertNoRunnableWork(WidgetUpdateWorker.NETWORK_RETRY_WORK_NAME);
        assertNoRunnableWork(MarketWidgetUpdateWorker.WORK_NAME);
        assertNoRunnableWork(MarketWidgetUpdateWorker.NETWORK_RETRY_WORK_NAME);
        assertFalse(AppWidgetUtils.INSTANCE.isWidgetAvailable(context));
    }

    private void assertNoRunnableWork(String uniqueWorkName) throws Exception {
        List<WorkInfo> work = WorkManager.getInstance(context).getWorkInfosForUniqueWork(uniqueWorkName).get(5, TimeUnit.SECONDS);
        assertTrue(work.isEmpty());
    }

    private void assertNoTaggedWork(String tag) throws Exception {
        List<WorkInfo> work = WorkManager.getInstance(context).getWorkInfosByTag(tag).get(5, TimeUnit.SECONDS);
        assertTrue(work.isEmpty());
    }
}
