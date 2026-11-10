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
  faFileArrowUp,
  faFileZipper,
  faFolderPlus,
  faHashtag,
  faImages,
  faSignOutAlt,
  faTriangleExclamation
} from '@fortawesome/free-solid-svg-icons';

export const mergeEntries = {
  MANAGE: { routeId: '/manage', label: 'Manager', icon: faSignOutAlt, title: 'Go to Book Manager' },
  LIBRARY: {
    routeId: '/library',
    label: 'Library',
    icon: faBookAtlas,
    title: 'Browse the Calibre library'
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
  JUMP_TO_POSITION: {
    routeId: '',
    label: 'Jump',
    icon: faHashtag,
    title: 'Jump to Position'
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
