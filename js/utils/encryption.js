//js/utils/encryption.js

const PASSPHRASE_STORAGE_KEY = 'monochrome-settings-passphrase';
const SESSION_KEY_STORAGE = 'monochrome-session-key';
const PERSISTED_PASSPHRASE_STORAGE = 'monochrome-persisted-passphrase';

async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);
    const saltBuffer = typeof salt === 'string' ? encoder.encode(salt) : salt;

    const baseKey = await crypto.subtle.importKey('raw', passwordBuffer, { name: 'PBKDF2' }, false, [
        'deriveBits',
        'deriveKey',
    ]);

    return await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: saltBuffer,
            iterations: 100000,
            hash: 'SHA-256',
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function encrypt(data, uid, passphrase) {
    try {
        const password = `${passphrase}:${uid}`;

        // Generate random 16-byte salt per encryption
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveKey(password, salt);

        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(JSON.stringify(data));

        // Generate random 12-byte IV
        const iv = crypto.getRandomValues(new Uint8Array(12));

        const encryptedBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, dataBuffer);

        // Combine: salt (16) + IV (12) + ciphertext
        const encryptedArray = new Uint8Array(encryptedBuffer);
        const combined = new Uint8Array(salt.length + iv.length + encryptedArray.length);
        combined.set(salt);
        combined.set(iv, salt.length);
        combined.set(encryptedArray, salt.length + iv.length);

        return btoa(String.fromCharCode(...combined));
    } catch (error) {
        console.error('[Encryption] Failed to encrypt:', error);
        return null;
    }
}

export async function decrypt(encryptedBase64, uid, passphrase) {
    try {
        const combined = new Uint8Array(
            atob(encryptedBase64)
                .split('')
                .map((c) => c.charCodeAt(0))
        );

        if (combined.length < 29) return null; // 16 salt + 12 IV + 1 min ciphertext

        const salt = combined.slice(0, 16);
        const iv = combined.slice(16, 28);
        const encrypted = combined.slice(28);

        const password = `${passphrase}:${uid}`;
        const key = await deriveKey(password, salt);

        const decryptedBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
        const decoder = new TextDecoder();
        return JSON.parse(decoder.decode(decryptedBuffer));
    } catch (error) {
        console.error('[Encryption] Failed to decrypt:', error);
        return null;
    }
}

// Passphrase Management — SHA-256 with random salt
export async function hasPassphrase() {
    return !!localStorage.getItem(PASSPHRASE_STORAGE_KEY);
}

export async function setPassphrase(passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encoder = new TextEncoder();
    const data = encoder.encode(passphrase + ':' + Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join(''));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join('');

    localStorage.setItem(PASSPHRASE_STORAGE_KEY, JSON.stringify({ salt: saltHex, hash: hashHex }));
}

export async function verifyPassphrase(passphrase) {
    const stored = localStorage.getItem(PASSPHRASE_STORAGE_KEY);
    if (!stored) return false;

    try {
        const { salt, hash } = JSON.parse(stored);
        const encoder = new TextEncoder();
        const data = encoder.encode(passphrase + ':' + salt);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
        return hashHex === hash;
    } catch {
        return false;
    }
}

export function clearPassphrase() {
    localStorage.removeItem(PASSPHRASE_STORAGE_KEY);
    clearPersistedPassphrase();
}

// Session persistence — encrypt passphrase with a random session key in localStorage
export async function persistPassphrase(passphrase) {
    try {
        const sessionKey = crypto.getRandomValues(new Uint8Array(32));
        const importedKey = await crypto.subtle.importKey('raw', sessionKey, { name: 'AES-GCM', length: 256 }, false, [
            'encrypt',
        ]);

        const encoder = new TextEncoder();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, importedKey, encoder.encode(passphrase));

        const encryptedArray = new Uint8Array(encrypted);
        const combined = new Uint8Array(iv.length + encryptedArray.length);
        combined.set(iv);
        combined.set(encryptedArray, iv.length);

        localStorage.setItem(
            SESSION_KEY_STORAGE,
            Array.from(sessionKey)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
        );
        localStorage.setItem(PERSISTED_PASSPHRASE_STORAGE, btoa(String.fromCharCode(...combined)));
    } catch (error) {
        console.warn('[Encryption] Failed to persist passphrase:', error);
    }
}

export async function getPersistedPassphrase() {
    try {
        const sessionKeyHex = localStorage.getItem(SESSION_KEY_STORAGE);
        const encryptedB64 = localStorage.getItem(PERSISTED_PASSPHRASE_STORAGE);
        if (!sessionKeyHex || !encryptedB64) return null;

        const sessionKey = new Uint8Array(sessionKeyHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
        const importedKey = await crypto.subtle.importKey(
            'raw',
            sessionKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );

        const combined = new Uint8Array(
            atob(encryptedB64)
                .split('')
                .map((c) => c.charCodeAt(0))
        );

        const iv = combined.slice(0, 12);
        const encrypted = combined.slice(12);

        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, importedKey, encrypted);
        return new TextDecoder().decode(decrypted);
    } catch {
        // Session data corrupted or tampered with, clear it
        clearPersistedPassphrase();
        return null;
    }
}

export function clearPersistedPassphrase() {
    localStorage.removeItem(SESSION_KEY_STORAGE);
    localStorage.removeItem(PERSISTED_PASSPHRASE_STORAGE);
}

// UI Modals
export function promptForPassphrase(customValidator = null) {
    return new Promise((resolve) => {
        let modal = document.getElementById('passphrase-modal');
        if (modal) {
            modal.remove();
        }

        modal = document.createElement('div');
        modal.id = 'passphrase-modal';
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Enter Sync Passphrase</h3>
                    <button class="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <p>Enter your passphrase to access your synced settings:</p>
                    <input type="password" id="passphrase-input" placeholder="••••••••">
                    <p id="passphrase-error" style="color: var(--destructive); display: none;">Incorrect passphrase. Please try again.</p>
                </div>
                <div class="modal-footer">
                    <button id="passphrase-submit" class="btn btn-primary">Submit</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const input = modal.querySelector('#passphrase-input');
        const submitBtn = modal.querySelector('#passphrase-submit');
        const errorMsg = modal.querySelector('#passphrase-error');
        const closeBtn = modal.querySelector('.modal-close');

        input.focus();

        const submitPassphrase = async () => {
            const passphrase = input.value.trim();
            if (passphrase.length >= 4) {
                let valid;
                if (customValidator) {
                    valid = await customValidator(passphrase);
                } else {
                    valid = await verifyPassphrase(passphrase);
                }

                if (valid) {
                    modal.remove();
                    resolve(passphrase);
                } else {
                    errorMsg.style.display = 'block';
                    input.value = '';
                    input.focus();
                }
            }
        };

        submitBtn.addEventListener('click', submitPassphrase);
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') submitPassphrase();
        });
        closeBtn.addEventListener('click', () => {
            modal.remove();
            resolve(null);
        });
        modal.querySelector('.modal-overlay').addEventListener('click', () => {
            modal.remove();
            resolve(null);
        });
    });
}

export function showSetPassphraseModal() {
    return new Promise((resolve) => {
        let modal = document.getElementById('set-passphrase-modal');
        if (modal) {
            modal.remove();
        }

        modal = document.createElement('div');
        modal.id = 'set-passphrase-modal';
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Set Sync Passphrase</h3>
                    <button class="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <p>Create a passphrase (4+ characters) to encrypt your synced settings:</p>
                    <input type="password" id="new-passphrase-input" placeholder="New passphrase">
                    <input type="password" id="confirm-passphrase-input" placeholder="Confirm passphrase" style="margin-top: 10px;">
                    <p id="passphrase-set-error" style="color: var(--destructive); display: none;"></p>
                </div>
                <div class="modal-footer">
                    <button id="passphrase-save" class="btn btn-primary">Save Passphrase</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const newInput = modal.querySelector('#new-passphrase-input');
        const confirmInput = modal.querySelector('#confirm-passphrase-input');
        const saveBtn = modal.querySelector('#passphrase-save');
        const errorMsg = modal.querySelector('#passphrase-set-error');
        const closeBtn = modal.querySelector('.modal-close');

        newInput.focus();

        const savePassphrase = async () => {
            const passphrase = newInput.value.trim();
            const confirmPassphrase = confirmInput.value.trim();

            if (passphrase.length < 4) {
                errorMsg.textContent = 'Passphrase must be at least 4 characters.';
                errorMsg.style.display = 'block';
                return;
            }

            if (passphrase !== confirmPassphrase) {
                errorMsg.textContent = 'Passphrases do not match.';
                errorMsg.style.display = 'block';
                return;
            }

            await setPassphrase(passphrase);
            modal.remove();
            resolve(passphrase);
        };

        saveBtn.addEventListener('click', savePassphrase);
        confirmInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') savePassphrase();
        });
        closeBtn.addEventListener('click', () => {
            modal.remove();
            resolve(null);
        });
        modal.querySelector('.modal-overlay').addEventListener('click', () => {
            modal.remove();
            resolve(null);
        });
    });
}
