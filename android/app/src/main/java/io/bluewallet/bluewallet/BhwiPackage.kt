package io.bluewallet.bluewallet

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class BhwiPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == BhwiModule.NAME) BhwiModule(reactContext) else null

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            BhwiModule.NAME to ReactModuleInfo(
                BhwiModule.NAME,
                BhwiModule::class.java.name,
                false,
                false,
                false,
                true,
            ),
        )
    }
}
