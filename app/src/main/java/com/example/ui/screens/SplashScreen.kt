package com.example.ui.screens

import android.content.Context
import android.net.Uri
import android.util.Log
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.RawResourceDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.example.R
import kotlinx.coroutines.delay

/**
 * Controls how [SplashScreen] plays the local intro video.
 * Production always uses [ExoPlayerDefault] with `R.raw.intro`.
 */
sealed class SplashVideoPlaybackMode {
    /** Real offline playback via Jetpack Media3 ExoPlayer using `app/src/main/res/raw/intro.mp4`. */
    object ExoPlayerDefault : SplashVideoPlaybackMode()

    /** Deterministic test hook that simulates video playback reaching `Player.STATE_ENDED`. */
    object SimulateEnded : SplashVideoPlaybackMode()

    /** Deterministic test hook that simulates an ExoPlayer playback error. */
    data class SimulateError(val reason: String = "Simulated video error") : SplashVideoPlaybackMode()
}

private const val SPLASH_TAG = "VideoSplashScreen"
private const val SPLASH_SAFETY_TIMEOUT_MS = 10_000L
internal const val INTRO_VIDEO_MUTED_VOLUME = 0f
private val SplashBrandRed = Color(0xFFB70C0C)

/**
 * Builds the local offline Android resource URI pointing to `app/src/main/res/raw/intro.mp4`.
 */
@OptIn(UnstableApi::class)
fun buildIntroVideoUri(context: Context): Uri {
    return runCatching {
        RawResourceDataSource.buildRawResourceUri(R.raw.intro)
    }.getOrElse {
        Uri.parse("android.resource://${context.packageName}/${R.raw.intro}")
    }
}

/**
 * Creates a strictly muted [ExoPlayer] instance for the intro splash video:
 * - Volume is permanently locked to 0.0f.
 * - Audio focus handling is disabled (`handleAudioFocus = false`) so phone calls,
 *   notifications, and other system audio are never interrupted or ducked.
 * - No microphone or audio permissions are required.
 */
@OptIn(UnstableApi::class)
internal fun createMutedIntroExoPlayer(context: Context, videoUri: Uri): ExoPlayer {
    val silentAudioAttributes = AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
        .build()

    return ExoPlayer.Builder(context)
        .setAudioAttributes(silentAudioAttributes, /* handleAudioFocus= */ false)
        .build()
        .apply {
            volume = INTRO_VIDEO_MUTED_VOLUME
            repeatMode = Player.REPEAT_MODE_OFF
            playWhenReady = true
            setMediaItem(MediaItem.fromUri(videoUri))
            prepare()
        }
}

@OptIn(UnstableApi::class)
@Composable
fun SplashScreen(
    isLoggedIn: Boolean = false,
    onNavigateNext: () -> Unit,
    videoUriOverride: Uri? = null,
    playbackMode: SplashVideoPlaybackMode = SplashVideoPlaybackMode.ExoPlayerDefault,
    safetyTimeoutMs: Long = SPLASH_SAFETY_TIMEOUT_MS
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnNavigateNext by rememberUpdatedState(onNavigateNext)

    var hasFinished by remember { mutableStateOf(false) }
    var isFirstFrameRendered by remember { mutableStateOf(false) }

    val finishSplashOnce: (String) -> Unit = remember {
        { reason ->
            if (!hasFinished) {
                hasFinished = true
                Log.i(SPLASH_TAG, "Intro splash completed ($reason); proceeding to auth check.")
                currentOnNavigateNext()
            }
        }
    }

    when (playbackMode) {
        is SplashVideoPlaybackMode.SimulateEnded -> {
            LaunchedEffect(Unit) {
                finishSplashOnce("simulated_ended")
            }
        }
        is SplashVideoPlaybackMode.SimulateError -> {
            LaunchedEffect(Unit) {
                Log.w(SPLASH_TAG, "Intro video playback error: ${playbackMode.reason}")
                finishSplashOnce("simulated_error")
            }
        }
        SplashVideoPlaybackMode.ExoPlayerDefault -> {
            val videoUri = remember(videoUriOverride) {
                videoUriOverride ?: buildIntroVideoUri(context)
            }

            val exoPlayer = remember(videoUri) {
                runCatching {
                    createMutedIntroExoPlayer(context, videoUri)
                }.onFailure { err ->
                    Log.e(SPLASH_TAG, "Failed to initialize Media3 ExoPlayer for intro video", err)
                }.getOrNull()
            }

            // Immediate fallback if ExoPlayer failed to initialize (e.g., missing codec or bad URI)
            LaunchedEffect(exoPlayer) {
                if (exoPlayer == null) {
                    finishSplashOnce("player_init_failed")
                }
            }

            // Safety watchdog so a stalled hardware decoder can never trap the captain on splash
            LaunchedEffect(exoPlayer, safetyTimeoutMs) {
                if (exoPlayer != null && safetyTimeoutMs > 0L) {
                    delay(safetyTimeoutMs)
                    if (!hasFinished) {
                        Log.w(SPLASH_TAG, "Intro splash safety timeout reached; falling back to auth check.")
                        finishSplashOnce("safety_timeout")
                    }
                }
            }

            // Attach Player.Listener and Lifecycle observer (pause on background, resume on foreground, release on dispose)
            DisposableEffect(exoPlayer, lifecycleOwner) {
                if (exoPlayer == null) {
                    onDispose { }
                } else {
                    val playerListener = object : Player.Listener {
                        override fun onRenderedFirstFrame() {
                            exoPlayer.volume = INTRO_VIDEO_MUTED_VOLUME
                            isFirstFrameRendered = true
                        }

                        override fun onVolumeChanged(volume: Float) {
                            if (volume != INTRO_VIDEO_MUTED_VOLUME) {
                                exoPlayer.volume = INTRO_VIDEO_MUTED_VOLUME
                            }
                        }

                        override fun onPlaybackStateChanged(playbackState: Int) {
                            exoPlayer.volume = INTRO_VIDEO_MUTED_VOLUME
                            if (playbackState == Player.STATE_ENDED) {
                                finishSplashOnce("playback_ended")
                            }
                        }

                        override fun onPlayerError(error: PlaybackException) {
                            Log.e(SPLASH_TAG, "Media3 ExoPlayer error (${error.errorCodeName}): ${error.message}", error)
                            finishSplashOnce("playback_error_${error.errorCodeName}")
                        }
                    }

                    val lifecycleObserver = LifecycleEventObserver { _, event ->
                        when (event) {
                            Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP -> {
                                if (!hasFinished) {
                                    exoPlayer.pause()
                                }
                            }
                            Lifecycle.Event.ON_RESUME -> {
                                if (!hasFinished && exoPlayer.playbackState != Player.STATE_ENDED) {
                                    exoPlayer.volume = INTRO_VIDEO_MUTED_VOLUME
                                    exoPlayer.playWhenReady = true
                                    exoPlayer.play()
                                }
                            }
                            else -> Unit
                        }
                    }

                    exoPlayer.volume = INTRO_VIDEO_MUTED_VOLUME
                    exoPlayer.addListener(playerListener)
                    lifecycleOwner.lifecycle.addObserver(lifecycleObserver)

                    onDispose {
                        lifecycleOwner.lifecycle.removeObserver(lifecycleObserver)
                        exoPlayer.removeListener(playerListener)
                        runCatching { exoPlayer.release() }
                    }
                }
            }

            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(SplashBrandRed)
                    .testTag("video_splash_screen"),
                contentAlignment = Alignment.Center
            ) {
                if (exoPlayer != null) {
                    AndroidView(
                        factory = { viewContext ->
                            PlayerView(viewContext).apply {
                                layoutParams = ViewGroup.LayoutParams(
                                    ViewGroup.LayoutParams.MATCH_PARENT,
                                    ViewGroup.LayoutParams.MATCH_PARENT
                                )
                                useController = false
                                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                                setShutterBackgroundColor(android.graphics.Color.parseColor("#B70C0C"))
                                keepScreenOn = true
                                player = exoPlayer
                            }
                        },
                        update = { playerView ->
                            if (playerView.player !== exoPlayer) {
                                playerView.player = exoPlayer
                            }
                        },
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("video_splash_player_view")
                    )
                }

                // Branded backdrop while first frame decodes (prevents black/white flash)
                if (!isFirstFrameRendered) {
                    Box(
                        modifier = Modifier
                            .size(148.dp)
                            .clip(CircleShape)
                            .background(Color.Black.copy(alpha = 0.25f)),
                        contentAlignment = Alignment.Center
                    ) {
                        Image(
                            painter = painterResource(id = R.drawable.el_batal_logo_1784764128367),
                            contentDescription = "شعار البطل إكسبريس",
                            modifier = Modifier
                                .fillMaxSize()
                                .clip(CircleShape)
                        )
                    }
                }
            }
            return
        }
    }

    // Fallback UI container for simulated test modes
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(SplashBrandRed)
            .testTag("video_splash_screen"),
        contentAlignment = Alignment.Center
    ) {
        Image(
            painter = painterResource(id = R.drawable.el_batal_logo_1784764128367),
            contentDescription = "شعار البطل إكسبريس",
            modifier = Modifier
                .size(148.dp)
                .clip(CircleShape)
        )
    }
}
