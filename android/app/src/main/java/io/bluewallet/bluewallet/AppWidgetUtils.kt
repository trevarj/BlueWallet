package io.bluewallet.bluewallet

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import androidx.work.WorkManager

internal val mainnetWidgetsEnabled = BuildConfig.BITCOIN_NETWORK == "bitcoin"

object AppWidgetUtils {
    private const val TAG = "AppWidgetUtils"
    private const val SHARED_PREF_NAME = "group.io.bluewallet.bluewallet"

    fun disableMainnetWidgets(context: Context) {
        if (mainnetWidgetsEnabled) return

        WorkManager.getInstance(context).apply {
            cancelUniqueWork(WidgetUpdateWorker.WORK_NAME)
            cancelUniqueWork(WidgetUpdateWorker.NETWORK_RETRY_WORK_NAME)
            cancelUniqueWork(MarketWidgetUpdateWorker.WORK_NAME)
            cancelUniqueWork(MarketWidgetUpdateWorker.NETWORK_RETRY_WORK_NAME)
        }
        context.getSharedPreferences(SHARED_PREF_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove("previous_price")
            .remove(MarketData.PREF_KEY)
            .apply()

        val appWidgetManager = AppWidgetManager.getInstance(context)
        val priceWidgetIds = getBitcoinPriceWidgetIds(context)
        if (priceWidgetIds.isNotEmpty()) {
            val views = RemoteViews(context.packageName, R.layout.widget_layout)
            views.setViewVisibility(R.id.loading_indicator, View.GONE)
            views.setViewVisibility(R.id.price_value, View.VISIBLE)
            views.setViewVisibility(R.id.last_updated_label, View.GONE)
            views.setViewVisibility(R.id.last_updated_time, View.GONE)
            views.setViewVisibility(R.id.price_arrow_container, View.GONE)
            views.setViewVisibility(R.id.network_status, View.GONE)
            views.setTextViewText(R.id.price_value, "Testnet4 unavailable")
            appWidgetManager.updateAppWidget(priceWidgetIds, views)
        }

        val marketWidgetIds = appWidgetManager.getAppWidgetIds(ComponentName(context, MarketWidget::class.java))
        if (marketWidgetIds.isNotEmpty()) {
            val views = RemoteViews(context.packageName, R.layout.widget_market)
            views.setViewVisibility(R.id.network_status, View.GONE)
            views.setTextViewText(R.id.next_block_value, "Testnet4")
            views.setTextViewText(R.id.sats_value, "Unavailable")
            views.setTextViewText(R.id.price_value, "Unavailable")
            appWidgetManager.updateAppWidget(marketWidgetIds, views)
        }
    }
    
    /**
     * Get all Bitcoin Price Widget IDs
     */
    fun getBitcoinPriceWidgetIds(context: Context): IntArray {
        val appWidgetManager = AppWidgetManager.getInstance(context)
        val component = ComponentName(context, BitcoinPriceWidget::class.java)
        return appWidgetManager.getAppWidgetIds(component)
    }
    
    /**
     * Trigger update for all widgets when theme changes
     */
    fun updateWidgetsForThemeChange(context: Context) {
        if (!mainnetWidgetsEnabled) return disableMainnetWidgets(context)
        Log.d(TAG, "Updating widgets for theme change")
        
        // Update Bitcoin Price widgets - force a complete refresh
        val bitcoinWidgetIds = getBitcoinPriceWidgetIds(context)
        if (bitcoinWidgetIds.isNotEmpty()) {
            Log.d(TAG, "Refreshing ${bitcoinWidgetIds.size} Bitcoin Price widgets")
            for (widgetId in bitcoinWidgetIds) {
                BitcoinPriceWidget.refreshWidget(context, widgetId)
            }
        }
        
        // Update Market widgets
        val marketWidgetIds = MarketWidget.getAllWidgetIds(context)
        if (marketWidgetIds.isNotEmpty()) {
            Log.d(TAG, "Refreshing ${marketWidgetIds.size} Market widgets")
            MarketWidget.refreshAllWidgetsImmediately(context)
        }
    }
    
    /**
     * Check if app widgets are supported and available on this device
     */
    fun isWidgetAvailable(context: Context): Boolean {
        if (!mainnetWidgetsEnabled) return false
        val appWidgetManager = AppWidgetManager.getInstance(context)
        return appWidgetManager != null
    }
    
    /**
     * Request to pin a widget to the home screen (Android 8.0+)
     */
    @RequiresApi(Build.VERSION_CODES.O)
    fun requestPinBitcoinWidget(context: Context): Boolean {
        if (!mainnetWidgetsEnabled) {
            disableMainnetWidgets(context)
            return false
        }
        val appWidgetManager = AppWidgetManager.getInstance(context)
        if (!appWidgetManager.isRequestPinAppWidgetSupported) {
            Log.w(TAG, "Pin widget not supported on this device")
            return false
        }
        
        val myProvider = ComponentName(context, BitcoinPriceWidget::class.java)
        return try {
            appWidgetManager.requestPinAppWidget(myProvider, null, null)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to request pin widget", e)
            false
        }
    }
    
    /**
     * Request to pin a market widget to the home screen (Android 8.0+)
     */
    @RequiresApi(Build.VERSION_CODES.O)
    fun requestPinMarketWidget(context: Context): Boolean {
        if (!mainnetWidgetsEnabled) {
            disableMainnetWidgets(context)
            return false
        }
        val appWidgetManager = AppWidgetManager.getInstance(context)
        if (!appWidgetManager.isRequestPinAppWidgetSupported) {
            Log.w(TAG, "Pin widget not supported on this device")
            return false
        }
        
        val myProvider = ComponentName(context, MarketWidget::class.java)
        return try {
            appWidgetManager.requestPinAppWidget(myProvider, null, null)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to request pin widget", e)
            false
        }
    }
    
    /**
     * Refresh all widgets by triggering updates
     */
    fun refreshAllWidgets(context: Context) {
        if (!mainnetWidgetsEnabled) return disableMainnetWidgets(context)
        Log.d(TAG, "Refreshing all widgets")
        
        // Refresh Bitcoin Price widgets
        val bitcoinWidgetIds = getBitcoinPriceWidgetIds(context)
        if (bitcoinWidgetIds.isNotEmpty()) {
            for (widgetId in bitcoinWidgetIds) {
                BitcoinPriceWidget.refreshWidget(context, widgetId)
            }
        }
        
        // Refresh Market widgets
        val marketWidgetIds = MarketWidget.getAllWidgetIds(context)
        if (marketWidgetIds.isNotEmpty()) {
            MarketWidget.refreshAllWidgetsImmediately(context)
        }
    }
}
