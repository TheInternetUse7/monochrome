//js/accounts/settings-sync.js
import { authManager } from './auth.js';
import { pb } from './pocketbase.js';
import {
    encrypt,
    decrypt,
    hasPassphrase,
    setPassphrase,
    promptForPassphrase,
    showSetPassphraseModal,
    persistPassphrase,
    getPersistedPassphrase,
    clearPassphrase as clearEncryptionPassphrase,
} from '../utils/encryption.js';
import {
    lastFMStorage,
    listenBrainzSettings,
    malojaSettings,
    libreFmSettings,
    themeManager,
    nowPlayingSettings,
    lyricsSettings,
    backgroundSettings,
    dynamicColorSettings,
    cardSettings,
    replayGainSettings,
    waveformSettings,
    smoothScrollingSettings,
    downloadQualitySettings,
    coverArtSizeSettings,
    qualityBadgeSettings,
    trackDateSettings,
    visualizerSettings,
    bulkDownloadSettings,
    playlistSettings,
    equalizerSettings,
    monoAudioSettings,
    exponentialVolumeSettings,
    audioEffectsSettings,
    homePageSettings,
    sidebarSectionSettings,
    fontSettings,
    pwaUpdateSettings,
    sidebarSettings,
} from '../storage.js';

let syncDebounceTimer = null;
const SYNC_DEBOUNCE_MS = 200;

let pollingInterval = null;
const POLLING_INTERVAL_MS = 5000; // Check for cloud changes every 5 seconds
const REALTIME_FALLBACK_POLLING_INTERVAL_MS = 8000; // Keep fallback fairly responsive
let lastSettingsHash = null;
let lastLocalSettingsFingerprint = null;
let realtimeSyncTimer = null;

// Store the current passphrase in memory for the session
let currentPassphrase = null;

const settingsSyncManager = {
    _isSyncing: false,
    _isWatching: false,
    _observers: [],
    _realtimeTopic: null,
    _realtimeUnsubscribe: null,
    _lastApplyRequiresReload: false,

    async _getUserRecord() {
        const user = authManager.user;
        if (!user) return null;

        try {
            const record = await pb
                .collection('DB_users')
                .getFirstListItem(`firebase_id="${user.uid}"`, { f_id: user.uid });
            return record;
        } catch (error) {
            if (error.status === 404) {
                return null;
            }
            throw error;
        }
    },

    collectAllSettings() {
        // Get session data from localStorage
        let lastfmSession = null;
        let librefmSession = null;

        try {
            const lastfmSessionStr = localStorage.getItem('lastfm-session');
            if (lastfmSessionStr) {
                lastfmSession = JSON.parse(lastfmSessionStr);
            }
        } catch {
            console.warn('[SettingsSync] Failed to collect Last.fm session');
        }

        try {
            const librefmSessionStr = localStorage.getItem('librefm-session');
            if (librefmSessionStr) {
                librefmSession = JSON.parse(librefmSessionStr);
            }
        } catch {
            console.warn('[SettingsSync] Failed to collect Libre.fm session');
        }

        const settings = {
            // Scrobbling services
            scrobbling: {
                lastfm: {
                    enabled: lastFMStorage.isEnabled(),
                    loveOnLike: lastFMStorage.shouldLoveOnLike(),
                    scrobblePercentage: lastFMStorage.getScrobblePercentage(),
                    useCustomCredentials: lastFMStorage.useCustomCredentials(),
                    customApiKey: lastFMStorage.getCustomApiKey(),
                    customApiSecret: lastFMStorage.getCustomApiSecret(),
                    session: lastfmSession,
                },
                listenbrainz: {
                    enabled: listenBrainzSettings.isEnabled(),
                    token: listenBrainzSettings.getToken(),
                    customUrl: listenBrainzSettings.getCustomUrl(),
                },
                maloja: {
                    enabled: malojaSettings.isEnabled(),
                    token: malojaSettings.getToken(),
                    customUrl: malojaSettings.getCustomUrl(),
                },
                librefm: {
                    enabled: libreFmSettings.isEnabled(),
                    loveOnLike: libreFmSettings.shouldLoveOnLike(),
                    session: librefmSession,
                },
            },

            // Appearance
            appearance: {
                theme: themeManager.getTheme(),
                customTheme: themeManager.getCustomTheme(),
                nowPlayingMode: nowPlayingSettings.getMode(),
                backgroundEnabled: backgroundSettings.isEnabled(),
                dynamicColorEnabled: dynamicColorSettings.isEnabled(),
            },

            // Audio
            audio: {
                replayGainMode: replayGainSettings.getMode(),
                replayGainPreamp: replayGainSettings.getPreamp(),
                equalizerEnabled: equalizerSettings.isEnabled(),
                equalizerGains: equalizerSettings.getGains(),
                equalizerPreset: equalizerSettings.getPreset(),
                monoAudio: monoAudioSettings.isEnabled(),
                exponentialVolume: exponentialVolumeSettings.isEnabled(),
                audioEffects: {
                    speed: audioEffectsSettings.getSpeed(),
                    pitch: audioEffectsSettings.getPitch(),
                    preservePitch: audioEffectsSettings.getPreservePitch(),
                },
            },

            // UI Preferences
            ui: {
                compactArtist: cardSettings.isCompactArtist(),
                compactAlbum: cardSettings.isCompactAlbum(),
                waveformEnabled: waveformSettings.isEnabled(),
                smoothScrolling: smoothScrollingSettings.isEnabled(),
                qualityBadges: qualityBadgeSettings.isEnabled(),
                trackDateMode: trackDateSettings.useAlbumYear(),
                visualizer: {
                    enabled: visualizerSettings.isEnabled(),
                    mode: visualizerSettings.getMode(),
                    preset: visualizerSettings.getPreset(),
                    sensitivity: visualizerSettings.getSensitivity(),
                    smartIntensity: visualizerSettings.isSmartIntensityEnabled(),
                    butterchurnCycle: visualizerSettings.getButterchurnCycleDuration(),
                    butterchurnCycleEnabled: visualizerSettings.isButterchurnCycleEnabled(),
                    butterchurnRandomize: visualizerSettings.isButterchurnRandomizeEnabled(),
                },
            },

            playlist: {
                generateM3U: playlistSettings.shouldGenerateM3U(),
                generateM3U8: playlistSettings.shouldGenerateM3U8(),
                generateCUE: playlistSettings.shouldGenerateCUE(),
                generateNFO: playlistSettings.shouldGenerateNFO(),
                generateJSON: playlistSettings.shouldGenerateJSON(),
                relativePaths: playlistSettings.shouldUseRelativePaths(),
            },

            // Home & Sidebar
            home: {
                showRecommendedSongs: homePageSettings.shouldShowRecommendedSongs(),
                showRecommendedAlbums: homePageSettings.shouldShowRecommendedAlbums(),
                showRecommendedArtists: homePageSettings.shouldShowRecommendedArtists(),
                showJumpBackIn: homePageSettings.shouldShowJumpBackIn(),
                showEditorsPicks: homePageSettings.shouldShowEditorsPicks(),
                shuffleEditorsPicks: homePageSettings.shouldShuffleEditorsPicks(),
            },

            sidebar: {
                showHome: sidebarSectionSettings.shouldShowHome(),
                showLibrary: sidebarSectionSettings.shouldShowLibrary(),
                showRecent: sidebarSectionSettings.shouldShowRecent(),
                showUnreleased: sidebarSectionSettings.shouldShowUnreleased(),
                showDonate: sidebarSectionSettings.shouldShowDonate(),
                showSettings: sidebarSectionSettings.shouldShowSettings(),
                showAccount: sidebarSectionSettings.shouldShowAccount(),
                showAbout: sidebarSectionSettings.shouldShowAbout(),
                showDownload: sidebarSectionSettings.shouldShowDownload(),
                showDiscord: sidebarSectionSettings.shouldShowDiscord(),
                collapsed: sidebarSettings.isCollapsed(),
                order: sidebarSectionSettings.getOrder(),
            },

            // Downloads & Playlist
            downloads: {
                quality: downloadQualitySettings.getQuality(),
                streamingQuality: localStorage.getItem('playback-quality') || 'HI_RES_LOSSLESS',
                coverArtSize: coverArtSizeSettings.getSize(),
                bulkForceIndividual: bulkDownloadSettings.shouldForceIndividual(),
                lyricsDownload: lyricsSettings.shouldDownloadLyrics(),
                romajiLyrics: localStorage.getItem('lyricsRomajiMode') === 'true',
                filenameTemplate: localStorage.getItem('filename-template') || '{trackNumber} - {artist} - {title}',
                zipFolderTemplate: localStorage.getItem('zip-folder-template') || '{albumTitle} - {albumArtist}',
            },

            // Font
            font: {
                config: fontSettings.getConfig(),
                customFonts: fontSettings.getCustomFonts(),
            },

            // PWA
            pwa: {
                autoUpdate: pwaUpdateSettings.isAutoUpdateEnabled(),
            },

            // Metadata
            _version: 1,
            _syncedAt: Date.now(),
        };

        return settings;
    },

    async applySettings(settings) {
        if (!settings || typeof settings !== 'object') {
            console.warn('[SettingsSync] Invalid settings object');
            return false;
        }

        try {
            let requiresReload = false;

            // Scrobbling services
            if (settings.scrobbling?.lastfm) {
                const lf = settings.scrobbling.lastfm;
                lastFMStorage.setEnabled(lf.enabled);
                lastFMStorage.setLoveOnLike(lf.loveOnLike);
                lastFMStorage.setScrobblePercentage(lf.scrobblePercentage);
                lastFMStorage.setUseCustomCredentials(lf.useCustomCredentials);
                if (lf.customApiKey) lastFMStorage.setCustomApiKey(lf.customApiKey);
                if (lf.customApiSecret) lastFMStorage.setCustomApiSecret(lf.customApiSecret);
            }

            if (settings.scrobbling?.listenbrainz) {
                const lb = settings.scrobbling.listenbrainz;
                listenBrainzSettings.setEnabled(lb.enabled);
                if (lb.token) listenBrainzSettings.setToken(lb.token);
                if (lb.customUrl) listenBrainzSettings.setCustomUrl(lb.customUrl);
            }

            if (settings.scrobbling?.maloja) {
                const ma = settings.scrobbling.maloja;
                malojaSettings.setEnabled(ma.enabled);
                if (ma.token) malojaSettings.setToken(ma.token);
                if (ma.customUrl) malojaSettings.setCustomUrl(ma.customUrl);
            }

            if (settings.scrobbling?.librefm) {
                const lr = settings.scrobbling.librefm;
                libreFmSettings.setEnabled(lr.enabled);
                libreFmSettings.setLoveOnLike(lr.loveOnLike);
            }

            // Restore scrobbling sessions
            if (settings.scrobbling?.lastfm?.session) {
                try {
                    localStorage.setItem('lastfm-session', JSON.stringify(settings.scrobbling.lastfm.session));
                    console.log('[SettingsSync] Restored Last.fm session');
                } catch {
                    console.warn('[SettingsSync] Failed to restore Last.fm session');
                }
            }

            if (settings.scrobbling?.librefm?.session) {
                try {
                    localStorage.setItem('librefm-session', JSON.stringify(settings.scrobbling.librefm.session));
                    console.log('[SettingsSync] Restored Libre.fm session');
                } catch {
                    console.warn('[SettingsSync] Failed to restore Libre.fm session');
                }
            }

            // Trigger scrobblers to reload sessions
            window.dispatchEvent(new CustomEvent('scrobbling-sessions-restored'));

            // Appearance
            if (settings.appearance) {
                const app = settings.appearance;
                themeManager.setTheme(app.theme);
                if (app.customTheme) themeManager.setCustomTheme(app.customTheme);
                nowPlayingSettings.setMode(app.nowPlayingMode);
                backgroundSettings.setEnabled(app.backgroundEnabled);
                dynamicColorSettings.setEnabled(app.dynamicColorEnabled);
            }

            // Audio
            if (settings.audio) {
                const audio = settings.audio;
                replayGainSettings.setMode(audio.replayGainMode);
                replayGainSettings.setPreamp(audio.replayGainPreamp);
                equalizerSettings.setEnabled(audio.equalizerEnabled);
                equalizerSettings.setGains(audio.equalizerGains);
                equalizerSettings.setPreset(audio.equalizerPreset);
                monoAudioSettings.setEnabled(audio.monoAudio);
                exponentialVolumeSettings.setEnabled(audio.exponentialVolume);
                if (audio.audioEffects) {
                    if (typeof audioEffectsSettings.setSpeed === 'function') {
                        audioEffectsSettings.setSpeed(audio.audioEffects.speed);
                    }
                    if (typeof audioEffectsSettings.setPitch === 'function') {
                        audioEffectsSettings.setPitch(audio.audioEffects.pitch);
                    }
                    if (typeof audioEffectsSettings.setPreservePitch === 'function') {
                        audioEffectsSettings.setPreservePitch(audio.audioEffects.preservePitch);
                    }
                }
            }

            // UI
            if (settings.ui) {
                const ui = settings.ui;
                cardSettings.setCompactArtist(ui.compactArtist);
                cardSettings.setCompactAlbum(ui.compactAlbum);
                waveformSettings.setEnabled(ui.waveformEnabled);
                smoothScrollingSettings.setEnabled(ui.smoothScrolling);
                qualityBadgeSettings.setEnabled(ui.qualityBadges);
                trackDateSettings.setUseAlbumYear(ui.trackDateMode);
                if (ui.visualizer) {
                    const vis = ui.visualizer;
                    visualizerSettings.setEnabled(vis.enabled);
                    visualizerSettings.setMode(vis.mode);
                    visualizerSettings.setPreset(vis.preset);
                    visualizerSettings.setSensitivity(vis.sensitivity);
                    visualizerSettings.setSmartIntensity(vis.smartIntensity);
                    visualizerSettings.setButterchurnCycleDuration(vis.butterchurnCycle);
                    visualizerSettings.setButterchurnCycleEnabled(vis.butterchurnCycleEnabled);
                    visualizerSettings.setButterchurnRandomizeEnabled(vis.butterchurnRandomize);
                }
            }

            // Downloads
            if (settings.downloads) {
                const dl = settings.downloads;
                downloadQualitySettings.setQuality(dl.quality);

                if (dl.streamingQuality) {
                    localStorage.setItem('playback-quality', dl.streamingQuality);
                }

                if (dl.romajiLyrics !== undefined) {
                    localStorage.setItem('lyricsRomajiMode', dl.romajiLyrics ? 'true' : 'false');
                }

                if (dl.filenameTemplate) {
                    localStorage.setItem('filename-template', dl.filenameTemplate);
                }

                if (dl.zipFolderTemplate) {
                    localStorage.setItem('zip-folder-template', dl.zipFolderTemplate);
                }

                coverArtSizeSettings.setSize(dl.coverArtSize);
                bulkDownloadSettings.setForceIndividual(dl.bulkForceIndividual);
                lyricsSettings.setDownloadLyrics(dl.lyricsDownload);
            }

            // Playlist
            if (settings.playlist) {
                const pl = settings.playlist;
                playlistSettings.setGenerateM3U(pl.generateM3U);
                playlistSettings.setGenerateM3U8(pl.generateM3U8);
                playlistSettings.setGenerateCUE(pl.generateCUE);
                playlistSettings.setGenerateNFO(pl.generateNFO);
                playlistSettings.setGenerateJSON(pl.generateJSON);
                playlistSettings.setUseRelativePaths(pl.relativePaths);
            }

            // Home
            if (settings.home) {
                const home = settings.home;
                homePageSettings.setShowRecommendedSongs(home.showRecommendedSongs);
                homePageSettings.setShowRecommendedAlbums(home.showRecommendedAlbums);
                homePageSettings.setShowRecommendedArtists(home.showRecommendedArtists);
                homePageSettings.setShowJumpBackIn(home.showJumpBackIn);
                homePageSettings.setShowEditorsPicks(home.showEditorsPicks);
                homePageSettings.setShuffleEditorsPicks(home.shuffleEditorsPicks);
            }

            // Sidebar
            if (settings.sidebar) {
                const sb = settings.sidebar;
                sidebarSectionSettings.setShowHome(sb.showHome);
                sidebarSectionSettings.setShowLibrary(sb.showLibrary);
                sidebarSectionSettings.setShowRecent(sb.showRecent);
                sidebarSectionSettings.setShowUnreleased(sb.showUnreleased);
                sidebarSectionSettings.setShowDonate(sb.showDonate);
                sidebarSectionSettings.setShowSettings(sb.showSettings);
                sidebarSectionSettings.setShowAccount(sb.showAccount);
                sidebarSectionSettings.setShowAbout(sb.showAbout);
                sidebarSectionSettings.setShowDownload(sb.showDownload);
                sidebarSectionSettings.setShowDiscord(sb.showDiscord);

                if (sb.collapsed !== undefined) {
                    const wasCollapsed = sidebarSettings.isCollapsed();
                    sidebarSettings.setCollapsed(sb.collapsed);
                    if (wasCollapsed !== sb.collapsed) {
                        document.body.classList.toggle('sidebar-collapsed', sb.collapsed);
                    }
                }

                if (sb.order) sidebarSectionSettings.setOrder(sb.order);
            }

            // Font
            if (settings.font?.config) {
                const currentConfig = fontSettings.getConfig();
                const nextConfig = settings.font.config;
                if (JSON.stringify(currentConfig) !== JSON.stringify(nextConfig)) {
                    fontSettings.setConfig(nextConfig);
                    try {
                        fontSettings.applyFont();
                    } catch (error) {
                        console.warn('[SettingsSync] Font apply requires refresh fallback:', error);
                        requiresReload = true;
                    }
                }
            }

            // PWA
            if (settings.pwa) {
                pwaUpdateSettings.setAutoUpdateEnabled(settings.pwa.autoUpdate);
            }

            this._lastApplyRequiresReload = requiresReload;
            return true;
        } catch (error) {
            console.error('[SettingsSync] Failed to apply settings:', error);
            return false;
        }
    },

    async ensurePassphrase(checkCloudFirst = false) {
        // If we already have the passphrase in memory, use it
        if (currentPassphrase) {
            return currentPassphrase;
        }

        // Try to recover from persisted session
        const persisted = await getPersistedPassphrase();
        if (persisted) {
            currentPassphrase = persisted;
            return currentPassphrase;
        }

        // Check if encrypted settings exist in cloud (only when downloading or first sync)
        let hasCloudSettings = false;
        let cloudRecord = null;
        if (checkCloudFirst) {
            try {
                const user = authManager.user;
                if (user) {
                    cloudRecord = await this._getUserRecord();
                    hasCloudSettings = !!(cloudRecord && cloudRecord.settings);
                }
            } catch {
                hasCloudSettings = false;
            }
        }

        // Check if passphrase is set locally
        const hasLocalPassphrase = await hasPassphrase();

        if (!hasLocalPassphrase && hasCloudSettings) {
            // No local passphrase but cloud settings exist — need to enter existing passphrase
            console.log('[SettingsSync] Cloud settings found but no local passphrase, prompting...');

            // Validator that checks if the passphrase can decrypt the cloud settings
            const validator = async (inputPassphrase) => {
                try {
                    const user = authManager.user;
                    const decrypted = await decrypt(cloudRecord.settings, user.uid, inputPassphrase);
                    return !!decrypted;
                } catch {
                    return false;
                }
            };

            const passphrase = await promptForPassphrase(validator);
            if (passphrase) {
                await setPassphrase(passphrase);
                currentPassphrase = passphrase;
                await persistPassphrase(passphrase);
                return currentPassphrase;
            }
            return null;
        }

        if (!hasLocalPassphrase && !hasCloudSettings) {
            // No passphrase set and no cloud settings — prompt to create one
            console.log('[SettingsSync] No passphrase set, showing setup modal...');
            const passphrase = await showSetPassphraseModal();
            if (passphrase) {
                currentPassphrase = passphrase;
                await persistPassphrase(passphrase);
                return currentPassphrase;
            }
            return null;
        }

        // Passphrase exists locally, prompt for it
        console.log('[SettingsSync] Passphrase required, showing prompt...');
        const passphrase = await promptForPassphrase();
        if (passphrase) {
            currentPassphrase = passphrase;
            await persistPassphrase(passphrase);
            return currentPassphrase;
        }
        return null;
    },

    setPassphrase(passphrase) {
        currentPassphrase = passphrase;
        persistPassphrase(passphrase);
    },

    clearPassphrase() {
        currentPassphrase = null;
        clearEncryptionPassphrase();
    },

    async changePassphrase() {
        const user = authManager.user;
        if (!user) return false;

        // Step 1: Verify old passphrase
        const oldPassphrase = await promptForPassphrase();
        if (!oldPassphrase) return false;

        // Step 2: Get new passphrase
        const newPassphrase = await showSetPassphraseModal();
        if (!newPassphrase) return false;

        this._isSyncing = true;

        try {
            // Step 3: Download and decrypt with old passphrase
            const record = await this._getUserRecord();
            if (record && record.settings) {
                const decrypted = await decrypt(record.settings, user.uid, oldPassphrase);
                if (!decrypted) {
                    console.error('[SettingsSync] Failed to decrypt with old passphrase during change');
                    return false;
                }

                // Step 4: Re-encrypt with new passphrase and upload
                const encrypted = await encrypt(decrypted, user.uid, newPassphrase);
                if (!encrypted) {
                    console.error('[SettingsSync] Failed to re-encrypt with new passphrase');
                    return false;
                }

                await pb.collection('DB_users').update(record.id, { settings: encrypted }, { f_id: user.uid });
                lastSettingsHash = encrypted.substring(0, 50);
            } else {
                // No cloud data, just sync current settings with new passphrase
                const settings = this.collectAllSettings();
                const encrypted = await encrypt(settings, user.uid, newPassphrase);
                if (!encrypted) return false;

                if (record) {
                    await pb.collection('DB_users').update(record.id, { settings: encrypted }, { f_id: user.uid });
                    lastSettingsHash = encrypted.substring(0, 50);
                }
            }

            // Step 5: Update local state
            currentPassphrase = newPassphrase;
            await persistPassphrase(newPassphrase);
            console.log('[SettingsSync] ✓ Passphrase changed successfully');
            return true;
        } catch (error) {
            console.error('[SettingsSync] Failed to change passphrase:', error);
            return false;
        } finally {
            this._isSyncing = false;
        }
    },

    async syncToCloud() {
        const user = authManager.user;
        if (!user) {
            console.log('[SettingsSync] No user logged in, skipping sync');
            return false;
        }

        if (this._isSyncing) {
            console.log('[SettingsSync] Already syncing, skipping');
            return false;
        }

        // Ensure we have a passphrase (check cloud first to avoid overwriting existing data)
        const passphrase = await this.ensurePassphrase(true);
        if (!passphrase) {
            console.log('[SettingsSync] No passphrase provided, skipping sync');
            return false;
        }

        this._isSyncing = true;

        try {
            const settings = this.collectAllSettings();
            const encrypted = await encrypt(settings, user.uid, passphrase);

            if (!encrypted) {
                console.error('[SettingsSync] Encryption failed');
                return false;
            }

            const record = await this._getUserRecord();
            if (!record) {
                console.error('[SettingsSync] No user record found');
                return false;
            }

            await pb.collection('DB_users').update(record.id, { settings: encrypted }, { f_id: user.uid });

            // Update hash so we don't detect our own changes
            lastSettingsHash = encrypted.substring(0, 50);
            lastLocalSettingsFingerprint = this._getLocalSettingsFingerprint();

            console.log('[SettingsSync] ✓ Settings synced to cloud');
            return true;
        } catch (error) {
            console.error('[SettingsSync] Failed to sync to cloud:', error);
            return false;
        } finally {
            this._isSyncing = false;
        }
    },

    async syncFromCloud() {
        const user = authManager.user;
        if (!user) {
            console.log('[SettingsSync] No user logged in, skipping sync');
            return false;
        }

        // Ensure we have a passphrase (check cloud first since we're downloading)
        const passphrase = await this.ensurePassphrase(true);
        if (!passphrase) {
            console.log('[SettingsSync] No passphrase provided, skipping sync');
            return false;
        }

        this._isSyncing = true;

        try {
            const record = await this._getUserRecord();
            if (!record || !record.settings) {
                console.log('[SettingsSync] No settings in cloud, will sync local settings up');
                await this.syncToCloud();
                return false;
            }

            const decrypted = await decrypt(record.settings, user.uid, passphrase);
            if (!decrypted) {
                console.error('[SettingsSync] Decryption failed - wrong passphrase?');
                // Clear passphrase so user can retry
                this.clearPassphrase();
                return false;
            }

            const applied = await this.applySettings(decrypted);
            if (applied) {
                console.log('[SettingsSync] ✓ Settings synced from cloud');
                // Update hash to prevent re-syncing same changes
                lastSettingsHash = record.settings.substring(0, 50);
                lastLocalSettingsFingerprint = this._getLocalSettingsFingerprint();
                window.dispatchEvent(
                    new CustomEvent('settings-synced-from-cloud', {
                        detail: { requiresReload: this._lastApplyRequiresReload === true },
                    })
                );
            }
            return applied;
        } catch (error) {
            console.error('[SettingsSync] Failed to sync from cloud:', error);
            return false;
        } finally {
            this._isSyncing = false;
        }
    },

    debouncedSyncToCloud() {
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
        }
        syncDebounceTimer = setTimeout(() => {
            this.syncToCloud();
        }, SYNC_DEBOUNCE_MS);
    },

    async _getSettingsHash() {
        const user = authManager.user;
        if (!user) return null;

        try {
            const record = await this._getUserRecord();
            if (!record || !record.settings) return null;
            // Use first 50 chars of encrypted string as hash
            return record.settings.substring(0, 50);
        } catch {
            return null;
        }
    },

    async _pollForChanges() {
        const user = authManager.user;
        if (!user || this._isSyncing) return;

        // Ensure local changes are pushed even if a settingsChanged event was missed.
        const localChanged = await this._syncLocalChangesIfNeeded();
        if (localChanged) {
            return;
        }

        // Skip polling if we don't have a passphrase and one is required
        const hasLocal = await hasPassphrase();
        if (hasLocal && !currentPassphrase) {
            // Try to recover from persisted session first
            const persisted = await getPersistedPassphrase();
            if (persisted) {
                currentPassphrase = persisted;
            } else {
                // We know there's a passphrase set but user hasn't entered it yet
                // Check if there are cloud changes
                try {
                    const currentHash = await this._getSettingsHash();
                    if (currentHash && currentHash !== lastSettingsHash) {
                        console.log('[SettingsSync] Cloud changes detected, prompting for passphrase...');
                        const passphrase = await promptForPassphrase();
                        if (passphrase) {
                            currentPassphrase = passphrase;
                            await persistPassphrase(passphrase);
                            lastSettingsHash = currentHash;
                            await this.syncFromCloud();
                        }
                    }
                } catch (error) {
                    console.warn('[SettingsSync] Polling error:', error);
                }
                return;
            }
        }

        // If no passphrase is set up yet, just check for hash changes
        if (!hasLocal) {
            try {
                const currentHash = await this._getSettingsHash();
                if (currentHash && currentHash !== lastSettingsHash) {
                    console.log('[SettingsSync] Detected cloud changes, syncing...');
                    lastSettingsHash = currentHash;
                    await this.syncFromCloud();
                }
            } catch (error) {
                console.warn('[SettingsSync] Polling error:', error);
            }
            return;
        }

        // Normal polling with passphrase already available
        try {
            const currentHash = await this._getSettingsHash();
            if (currentHash && currentHash !== lastSettingsHash) {
                console.log('[SettingsSync] Detected cloud changes, syncing...');
                lastSettingsHash = currentHash;
                await this.syncFromCloud();
            }
        } catch (error) {
            console.warn('[SettingsSync] Polling error:', error);
        }
    },

    _getLocalSettingsFingerprint() {
        try {
            const settings = this.collectAllSettings();
            if (!settings || typeof settings !== 'object') return null;
            // Ignore volatile timestamp field in change detection.
            delete settings._syncedAt;
            return JSON.stringify(settings);
        } catch {
            return null;
        }
    },

    async _syncLocalChangesIfNeeded() {
        const current = this._getLocalSettingsFingerprint();
        if (!current) return false;

        if (lastLocalSettingsFingerprint === null) {
            lastLocalSettingsFingerprint = current;
            return false;
        }

        if (current === lastLocalSettingsFingerprint) {
            return false;
        }

        console.log('[SettingsSync] Local settings change detected, syncing to cloud...');
        const success = await this.syncToCloud();
        if (success) {
            lastLocalSettingsFingerprint = current;
            return true;
        }

        return false;
    },

    _startPolling(intervalMs = POLLING_INTERVAL_MS) {
        if (pollingInterval) {
            clearInterval(pollingInterval);
        }
        pollingInterval = setInterval(() => this._pollForChanges(), intervalMs);
    },

    async _stopRealtimeSubscription() {
        if (realtimeSyncTimer) {
            clearTimeout(realtimeSyncTimer);
            realtimeSyncTimer = null;
        }

        const topic = this._realtimeTopic;
        const unsubscribe = this._realtimeUnsubscribe;
        this._realtimeTopic = null;
        this._realtimeUnsubscribe = null;

        try {
            if (typeof unsubscribe === 'function') {
                await unsubscribe();
                return;
            }

            if (topic) {
                await pb.collection('DB_users').unsubscribe(topic);
            }
        } catch (error) {
            console.warn('[SettingsSync] Failed to stop realtime subscription:', error);
        }
    },

    async _startRealtimeSubscription() {
        const user = authManager.user;
        if (!user) return false;

        await this._stopRealtimeSubscription();

        try {
            const record = await this._getUserRecord();
            if (!record) return false;

            const topic = record.id;
            const unsubscribe = await pb.collection('DB_users').subscribe(
                topic,
                async (event) => {
                    if (!this._isWatching || this._isSyncing) return;

                    const remoteSettings = event?.record?.settings;
                    if (!remoteSettings) return;

                    const remoteHash = remoteSettings.substring(0, 50);
                    if (!remoteHash || remoteHash === lastSettingsHash) return;

                    // Prevent duplicate burst processing from SSE reconnects.
                    if (realtimeSyncTimer) {
                        clearTimeout(realtimeSyncTimer);
                    }
                    realtimeSyncTimer = setTimeout(async () => {
                        realtimeSyncTimer = null;
                        if (!this._isWatching || this._isSyncing) return;

                        console.log('[SettingsSync] Realtime cloud settings update detected, syncing...');
                        lastSettingsHash = remoteHash;
                        await this.syncFromCloud();
                    }, 120);
                },
                { query: { f_id: user.uid } }
            );

            this._realtimeTopic = topic;
            this._realtimeUnsubscribe = unsubscribe;
            return true;
        } catch (error) {
            console.warn('[SettingsSync] Realtime subscription unavailable, using polling fallback:', error);
            return false;
        }
    },

    startWatching() {
        if (this._isWatching) return;
        this._isWatching = true;

        // Watch for storage changes (from other tabs)
        const handleStorageChange = (e) => {
            // Only sync relevant keys
            if (
                e.key &&
                (e.key.includes('lastfm') ||
                    e.key.includes('listenbrainz') ||
                    e.key.includes('maloja') ||
                    e.key.includes('librefm') ||
                    e.key.includes('theme') ||
                    e.key.includes('equalizer') ||
                    e.key.includes('visualizer') ||
                    e.key.includes('font') ||
                    e.key.includes('settings') ||
                    e.key === 'playback-quality' ||
                    e.key === 'lyricsRomajiMode' ||
                    e.key === 'filename-template' ||
                    e.key === 'zip-folder-template' ||
                    e.key.includes('sidebar'))
            ) {
                this.debouncedSyncToCloud();
            }
        };

        window.addEventListener('storage', handleStorageChange);
        this._observers.push(() => window.removeEventListener('storage', handleStorageChange));

        // Watch for custom events
        const handleCustomEvent = () => this.debouncedSyncToCloud();
        window.addEventListener('settings-changed', handleCustomEvent);
        this._observers.push(() => window.removeEventListener('settings-changed', handleCustomEvent));

        // Establish cloud watch: realtime first, polling fallback always enabled.
        this._getSettingsHash().then(async (hash) => {
            if (!this._isWatching) return;
            lastSettingsHash = hash;
            lastLocalSettingsFingerprint = this._getLocalSettingsFingerprint();
            const realtimeEnabled = await this._startRealtimeSubscription();
            if (!this._isWatching) {
                await this._stopRealtimeSubscription();
                return;
            }
            if (realtimeEnabled) {
                this._startPolling(REALTIME_FALLBACK_POLLING_INTERVAL_MS);
                console.log(
                    `[SettingsSync] Started watching (realtime + ${REALTIME_FALLBACK_POLLING_INTERVAL_MS / 1000}s fallback polling)`
                );
            } else {
                this._startPolling(POLLING_INTERVAL_MS);
                console.log(`[SettingsSync] Started watching (polling every ${POLLING_INTERVAL_MS / 1000}s)`);
            }
        });
    },

    stopWatching() {
        this._observers.forEach((cleanup) => cleanup());
        this._observers = [];
        this._isWatching = false;

        void this._stopRealtimeSubscription();

        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }

        console.log('[SettingsSync] Stopped watching');
    },
};

export { settingsSyncManager };
