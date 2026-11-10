/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  faBookAtlas,
  faBug,
  faCircleHalfStroke,
  faChartLine,
  faCog,
  faEyeSlash,
  faKeyboard,
  faFileArrowUp,
  faFileZipper,
  faFolderPlus,
  faHashtag,
  faHouse,
  faImages,
  faLayerGroup,
  faListUl,
  faSignOutAlt,
  faTriangleExclamation
} from '@fortawesome/free-solid-svg-icons';

export const mergeEntries = {
  MANAGE: { routeId: '/manage', label: 'Manager', icon: faSignOutAlt, title: 'Go to Book Manager' },
  HOME: { routeId: '/home', label: 'Home', icon: faHouse, title: 'Go to Home' },
  LIBRARY: {
    routeId: '/library',
    label: 'Library',
    icon: faBookAtlas,
    title: 'Browse the Calibre library'
  },
  COLLECTIONS: {
    routeId: '/collections',
    label: 'Collections',
    icon: faLayerGroup,
    title: 'Your collections'
  },
  SETTINGS: {
    routeId: '/settings',
    label: 'Settings',
    icon: faCog,
    title: 'Go to Reader Settings'
  },
  STATISTICS: {
    routeId: '/statistics',
    label: 'Statistics',
    icon: faChartLine,
    title: 'Go to Statistics'
  },
  BOOK_STATUS: {
    routeId: '',
    label: 'Book status',
    icon: faCircleHalfStroke,
    title: 'Status, favorite and Start over'
  },
  ADD_TO_COLLECTION: {
    routeId: '',
    label: 'Add to collection',
    icon: faListUl,
    title: 'Add this book to a collection'
  },
  JUMP_TO_POSITION: {
    routeId: '',
    label: 'Jump',
    icon: faHashtag,
    title: 'Jump to Position'
  },
  ZEN_MODE: {
    routeId: '',
    label: 'Zen mode',
    icon: faEyeSlash,
    title: 'Hide or show the bottom bar (Z, or a two-finger tap)'
  },
  SHORTCUTS: {
    routeId: '',
    label: 'Shortcuts',
    icon: faKeyboard,
    title: 'Keys and gestures (?)'
  },
  READER_IMAGE_GALLERY: {
    routeId: '',
    label: 'Images',
    icon: faImages,
    title: 'Open Image Gallery'
  },
  DOMAIN_HINT: {
    routeId: '',
    label: 'Domain Hint',
    icon: faTriangleExclamation,
    title: 'Old Domain used'
  },
  BUG_REPORT: { routeId: '', label: 'Bug Report', icon: faBug, title: 'Report an Issue' },
  FOLDER_IMPORT: {
    routeId: '',
    label: 'Import Folder(s)',
    icon: faFolderPlus,
    title: 'Import from Folder'
  },
  FILE_IMPORT: { routeId: '', label: 'Import File(s)', icon: faFileArrowUp, title: 'Import Files' },
  BACKUP_IMPORT: { routeId: '', label: 'Import Backup', icon: faFileZipper, title: 'Import Backup' }
};
