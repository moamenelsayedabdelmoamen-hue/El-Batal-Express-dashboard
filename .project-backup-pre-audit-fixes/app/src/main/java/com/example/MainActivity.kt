package com.example

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.example.ui.CaptainViewModel
import com.example.ui.navigation.AppNavigation
import com.example.ui.theme.ElBatalTheme

class MainActivity : ComponentActivity() {
    private val captainViewModel: CaptainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ElBatalTheme {
                AppNavigation(viewModel = captainViewModel)
            }
        }
        runCatching { captainViewModel.handleNotificationIntent(intent) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        runCatching { captainViewModel.handleNotificationIntent(intent) }
    }
}

