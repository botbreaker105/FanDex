"use strict";

import { auth } from './auth.js';
import { getUserProfile, updateUserProfile } from './common/api-client.js';

let profileData = {
  trainerLevel: 1,
  description: '',
  sns: [],
  coins: 0
};

// Helper: Dynamically generate an SNS link input row with a delete button
function createLinkRow(url = '') {
  const row = document.createElement('div');
  row.className = 'profile-link-row';
  row.style.cssText = 'display:flex;gap:8px;align-items:center;';

  row.innerHTML = `
    <input type="url" class="profile-link-input" placeholder="https://twitter.com/yourhandle" value="${esc(url)}" style="flex:1;">
    <button type="button" class="btn-secondary remove-link-btn" style="padding:6px 10px;color:var(--danger, #ff5f5f);">✕</button>
  `;

  row.querySelector('.remove-link-btn').addEventListener('click', () => row.remove());
  return row;
}

/**
 * Load user data from Firestore / LocalStorage and update the UI
 */
export async function renderProfileUI() {
  const user = auth.currentUser;

  if (user) {
    try {
      // 1. Fetch live profile data from Firestore
      const dbProfile = await getUserProfile(user.uid);
      if (dbProfile) {
        profileData.coins = dbProfile.coins ?? 100;
        profileData.trainerLevel = dbProfile.trainerLevel ?? calculateLevel();
        profileData.description = dbProfile.description || '';
        profileData.sns = dbProfile.sns || [];
      }
    } catch (err) {
      console.warn('Could not load profile from database, using local storage fallback', err);
      const local = JSON.parse(localStorage.getItem('fandex_profile') || '{}');
      profileData.description = local.description || '';
      profileData.sns = local.sns || [];
      profileData.trainerLevel = calculateLevel();
    }
  }

  // 2. Update Top Header Bar
  const headerCoinsEl = document.getElementById('userCoins');
  const headerNameEl = document.getElementById('userDisplayName');
  if (headerCoinsEl) headerCoinsEl.textContent = profileData.coins;
  if (headerNameEl) headerNameEl.textContent = user?.displayName || 'Trainer';

  // 3. Update Profile View UI
  const profileNameEl = document.getElementById('profileName');
  const profileLevelEl = document.getElementById('profileLevel');
  const profileBioEl = document.getElementById('profileBio'); // corresponds to 'description'
  const profilePhotoEl = document.getElementById('profilePhoto');

  if (profileNameEl) profileNameEl.textContent = user?.displayName || 'Trainer';
  if (profileLevelEl) profileLevelEl.textContent = profileData.trainerLevel;
  if (profileBioEl) profileBioEl.value = profileData.description;
  if (profilePhotoEl && user?.photoURL) profilePhotoEl.src = user.photoURL;

  // 4. Render SNS Links list
  const linksContainer = document.getElementById('profileLinksList');
  if (linksContainer) {
    linksContainer.innerHTML = '';
    profileData.sns.forEach(url => {
      linksContainer.appendChild(createLinkRow(url));
    });
  }
}

/**
 * Auto-calculate trainer level based on total logged entries
 */
function calculateLevel() {
  const localCreatures = JSON.parse(localStorage.getItem('fandex_creatures') || '[]');
  return Math.max(1, 1 + Math.floor(localCreatures.length / 5));
}

/**
 * Initialize Profile listeners and submission
 */
export function initProfileUI() {
  const addLinkBtn = document.getElementById('addProfileLinkBtn');
  const linksContainer = document.getElementById('profileLinksList');
  const profileForm = document.getElementById('profileForm');

  if (addLinkBtn && linksContainer) {
    addLinkBtn.addEventListener('click', () => {
      linksContainer.appendChild(createLinkRow(''));
    });
  }

  if (profileForm) {
    profileForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const user = auth.currentUser;
      const bioInput = document.getElementById('profileBio');
      const linkInputs = document.querySelectorAll('.profile-link-input');

      // Collect URLs from input fields
      const updatedSns = Array.from(linkInputs)
        .map(input => input.value.trim())
        .filter(url => url.length > 0);

      profileData.description = bioInput ? bioInput.value.trim() : '';
      profileData.sns = updatedSns;
      profileData.trainerLevel = calculateLevel();

      // Backup to LocalStorage
      localStorage.setItem('fandex_profile', JSON.stringify({
        description: profileData.description,
        sns: profileData.sns,
        trainerLevel: profileData.trainerLevel
      }));

      // Save to Firestore
      if (user) {
        try {
          await updateUserProfile(user.uid, {
            description: profileData.description,
            sns: profileData.sns,
            trainerLevel: profileData.trainerLevel
          });
          alert('Profile updated successfully!');
        } catch (err) {
          console.error('Failed to update profile online:', err);
          alert('Profile saved locally (offline mode).');
        }
      } else {
        alert('Saved locally! Log in to save your profile online.');
      }

      renderProfileUI();
    });
  }

  renderProfileUI();
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', initProfileUI);