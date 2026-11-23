/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BOTTOM_IDS, TOP_IDS } from '$lib/reader-toolbar/toolbar-layout';
import { BOTTOM_LABELS, TOP_LABELS } from '$lib/reader-toolbar/toolbar-labels';
import { LINK_LABELS } from '$lib/book-links/link-labels';
import { BOOK_LINKS } from '$lib/book-links/links';
import type { SettingsTab } from './settings-tab';

/**
 * Every section and setting of the Settings page with its on-screen words, so the page and
 * "Search settings" can't disagree: a section (settings-group.svelte) and a row
 * (setting-row.svelte) read their title and description from here by id, and search
 * looks here. Ids are unique across the page; the DOM ids are `s-<section>` and
 * `setting-<row>`. A row's description may be replaced on screen by one that follows its
 * value (e.g. "Pause by itself"); `keywords` adds words people may search for.
 */

export interface CatalogSection {
  id: string;
  tab: SettingsTab;
  jp: string;
  title: string;
  description?: string;
  keywords?: string;
}

export interface CatalogSetting {
  id: string;
  section: string;
  title: string;
  description?: string;
  keywords?: string;
  /** A row that only shows while another is on: search opens the section instead. */
  parent?: string;
}

export const SETTINGS_SECTIONS: CatalogSection[] = [
  // Reader
  {
    id: 'reader-theme',
    tab: 'Reader',
    jp: '外観',
    title: 'Theme and display',
    description: 'How books look on this device.'
  },
  {
    id: 'reader-fonts',
    tab: 'Reader',
    jp: '書体',
    title: 'Fonts',
    description: 'Type a font’s name, or pick one with the A button.'
  },
  {
    id: 'reader-text',
    tab: 'Reader',
    jp: '組版',
    title: 'Text layout',
    description: 'How text is set on the page. Some of these apply only in one reading mode.'
  },
  {
    id: 'reader-pages',
    tab: 'Reader',
    jp: '操作',
    title: 'Turning pages',
    description: 'Taps, swipes, the mouse and the wheel.'
  },
  {
    id: 'reader-toolbars',
    tab: 'Reader',
    jp: '道具',
    title: 'Toolbars',
    description:
      'Which buttons the reader’s top bar and bottom bar show on this device, and in what order. Keys work whether or not their button is shown.',
    keywords: 'toolbar top bar bottom bar buttons menu order header footer'
  },
  {
    id: 'reader-bar',
    tab: 'Reader',
    jp: '表示',
    title: 'Bottom bar',
    description:
      'The progress text at the right of the reader’s bottom bar. Its buttons are under Toolbars; time left and the goals dot are under Statistics.'
  },
  {
    id: 'reader-place',
    tab: 'Reader',
    jp: '栞',
    title: 'Your place',
    description: 'When and how your place in a book is saved.'
  },
  {
    id: 'reader-opening',
    tab: 'Reader',
    jp: '起動',
    title: 'Opening books',
    description: 'What happens when the app or a book opens.'
  },
  { id: 'reader-highlights', tab: 'Reader', jp: '蛍光', title: 'Highlights' },
  { id: 'reader-images', tab: 'Reader', jp: '挿絵', title: 'Images' },
  {
    id: 'reader-pacer',
    tab: 'Reader',
    jp: '歩調',
    title: 'Pacer',
    description: 'Mode and speed are set inside a book: open the menu at the top and tap Pacer.'
  },
  {
    id: 'reader-readaloud',
    tab: 'Reader',
    jp: '朗読',
    title: 'Read aloud',
    description:
      'Play and speed are set inside a book: open the menu at the top and tap Read aloud (key V).'
  },
  // Library (calibre-metadata-display.md): Look, Book page, Links, Downloading books.
  {
    id: 'library-appearance',
    tab: 'Library',
    jp: '外観',
    title: 'Look',
    keywords: 'library theme'
  },
  {
    id: 'library-book-page',
    tab: 'Library',
    jp: '書誌',
    title: 'Book page',
    description: 'This device only.'
  },
  {
    id: 'library-links',
    tab: 'Library',
    jp: '外部リンク',
    title: 'Links',
    description:
      'This device only. Button: on the page. Menu: under More, in this order. Drag or use ↑ / ↓ to reorder.',
    keywords: 'store stores links external amazon bookwalker order'
  },
  {
    id: 'library-editing',
    tab: 'Library',
    jp: '編集',
    title: 'Editing',
    description: 'Editing a Calibre book’s details from the reader.',
    keywords: 'edit series tags calibre metadata'
  },
  {
    id: 'data-downloads',
    tab: 'Library',
    jp: '保存',
    title: 'Downloading books',
    description: 'Downloading several books at once with Select in the Library.'
  },
  // Data
  {
    id: 'data-server',
    tab: 'Data',
    jp: '接続',
    title: 'Library server',
    description: 'The server this device reads the library from.',
    keywords: 'connection disconnect timeout'
  },
  {
    id: 'data-sync',
    tab: 'Data',
    jp: '同期',
    title: 'Record sync',
    description:
      'Places, highlights, notes, statistics and settings shared with your other devices.'
  },
  { id: 'data-device', tab: 'Data', jp: 'この端末', title: 'This device' },
  { id: 'data-import', tab: 'Data', jp: '取込', title: 'Importing books' },
  {
    id: 'data-tools',
    tab: 'Data',
    jp: '道具',
    title: 'Tools',
    description: 'Pages for one-off jobs.'
  },
  // Statistics
  {
    id: 'stats-days',
    tab: 'Statistics',
    jp: '暦',
    title: 'Days and weeks',
    description: 'The same on every device.'
  },
  {
    id: 'stats-tracker',
    tab: 'Statistics',
    jp: '計測',
    title: 'Reading tracker',
    description: 'The timer for reading sessions, in the reader’s bottom-left corner.'
  },
  {
    id: 'stats-skipping',
    tab: 'Statistics',
    jp: '跳躍',
    title: 'Skipping',
    description: 'When a page change is a jump rather than reading.'
  },
  {
    id: 'stats-goals',
    tab: 'Statistics',
    jp: '目標',
    title: 'Goals',
    description: 'Goals themselves are set on the Stats page.'
  },
  {
    id: 'stats-bar',
    tab: 'Statistics',
    jp: '表示',
    title: 'In the bottom bar',
    description: 'What the reader’s bottom bar shows about your reading speed and goals.'
  },
  // Audiobooks
  {
    id: 'audio-folder',
    tab: 'Audiobooks',
    jp: '音源',
    title: 'Audiobooks folder',
    description: 'What the server’s last scan of its audiobooks and subtitle folders found.',
    keywords: 'scan'
  },
  {
    id: 'audio-books',
    tab: 'Audiobooks',
    jp: '蔵書',
    title: 'Books',
    description:
      'Books with a linked audiobook, and books marked “No audiobook”. Link a book’s audiobook on the book’s page.',
    keywords: 'linked no audiobook problems subtitles'
  },
  {
    id: 'audio-pc',
    tab: 'Audiobooks',
    jp: '字幕作成',
    title: 'The PC',
    description:
      'The PC makes subtitles, audiobooks and sentence audio. Ask for them in a book’s Audiobook section (Subtitles, Text-to-speech); jobs wait while the PC is off.',
    keywords: 'subtitles worker jobs pause gpu'
  },
  {
    id: 'audio-voices',
    tab: 'Audiobooks',
    jp: '声',
    title: 'Voices',
    description:
      'The TTS voices the PC can read a book aloud in (a book’s Audiobook section > Text-to-speech). Stored on the server, so every device has them.',
    keywords: 'recording describe'
  },
  {
    id: 'audio-pauses',
    tab: 'Audiobooks',
    jp: '間',
    title: 'Pauses in made audiobooks',
    description:
      'In milliseconds (1000 = one second), for audiobooks and previews started from now on. The same on every device.'
  },
  {
    id: 'audio-models',
    tab: 'Audiobooks',
    jp: 'モデル',
    title: 'Voice models',
    description: 'The speech models the PC can read a book with. You choose one per book.',
    keywords: 'tts irodori hugging face'
  },
  {
    id: 'audio-speakers',
    tab: 'Audiobooks',
    jp: '話者',
    title: 'Speaker models',
    description:
      'The models the PC uses to work out who speaks each quote, so characters can have voices of their own.',
    keywords: 'characters gguf'
  },
  {
    id: 'audio-fixes',
    tab: 'Audiobooks',
    jp: '読み方',
    title: 'Pronunciation fixes',
    description:
      'How text-to-speech reads a word, in every book. A book’s own list (on its page) wins over this one, and the book’s own furigana wins over both.',
    keywords: 'reading furigana'
  },
  // Anki
  {
    id: 'anki-connection',
    tab: 'Anki',
    jp: '接続',
    title: 'Connection',
    description: 'How this device reaches Anki (AnkiConnect). Saved on this device only.',
    keywords: 'ankiconnect'
  },
  {
    id: 'anki-enrich',
    tab: 'Anki',
    jp: '補完',
    title: 'Enriching cards',
    keywords: 'enrich yomitan'
  },
  {
    id: 'anki-audio',
    tab: 'Anki',
    jp: '音声',
    title: 'Sentence audio',
    keywords: 'clip subtitles pc voice'
  },
  {
    id: 'anki-fields',
    tab: 'Anki',
    jp: '項目',
    title: 'Card fields',
    description: 'Which field of each note type gets what. The same on every device.',
    keywords: 'note type mapping'
  },
  { id: 'anki-reader', tab: 'Anki', jp: '表示', title: 'In the reader' },
  {
    id: 'anki-pending',
    tab: 'Anki',
    jp: '待機',
    title: 'Waiting sentence audio',
    description: 'Sentence audio that couldn’t be added yet, waiting to be added to its card.',
    keywords: 'pending offline'
  },
  // AI
  {
    id: 'ai-keys',
    tab: 'AI',
    jp: '鍵',
    title: 'API keys',
    description:
      'Every AI feature uses these. They are kept encrypted on the server and never shown again.',
    keywords: 'anthropic openai claude gpt secret'
  },
  {
    id: 'ai-spending',
    tab: 'AI',
    jp: '費用',
    title: 'Spending',
    description:
      'One monthly limit for every AI feature together. Nothing is sent to a model until it is set; when it is reached, AI work waits until the next month or a higher limit.',
    keywords: 'limit cost money budget month'
  },
  {
    id: 'ai-models',
    tab: 'AI',
    jp: 'モデル',
    title: 'Models',
    description:
      'The models features can use. Batches cost half and take longer; one call each answers at once.',
    keywords: 'price batch test check haiku sonnet luna sol'
  },
  {
    id: 'ai-advanced',
    tab: 'AI',
    jp: '詳細',
    title: 'Advanced',
    description: 'Rarely needed tuning of how the models are asked.'
  },
  // Notifications
  {
    id: 'notify-channels',
    tab: 'Notifications',
    jp: '送信先',
    title: 'Where to send',
    description:
      'Both are optional. The webhook address and the app password are kept encrypted on the server and never shown again.',
    keywords: 'discord email gmail channels'
  },
  {
    id: 'notify-general',
    tab: 'Notifications',
    jp: '一般',
    title: 'When and how',
    description:
      'Alerts go out at once, at most one per problem. Everything else waits for one daily summary, sent only on days with something to say.',
    keywords: 'digest summary'
  },
  {
    id: 'notify-waits',
    tab: 'Notifications',
    jp: '待ち時間',
    title: 'Wait before an alert',
    description:
      'Some problems fix themselves (the PC starting up, a helper restarting). These alert only after they have lasted this long.'
  },
  // Diagnostics
  {
    id: 'diag-device',
    tab: 'Diagnostics',
    jp: 'この端末',
    title: 'This device',
    keywords: 'version storage sync'
  },
  {
    id: 'diag-devices',
    tab: 'Diagnostics',
    jp: '端末一覧',
    title: 'All devices',
    description:
      'Every device that has synced with the library server. A new pairing or a new address counts as a new device.',
    keywords: 'last seen'
  },
  { id: 'diag-worker', tab: 'Diagnostics', jp: 'パソコン', title: 'PC worker' },
  { id: 'diag-helper', tab: 'Diagnostics', jp: '蔵書整理', title: 'Cleanup helper' },
  {
    id: 'diag-notify',
    tab: 'Diagnostics',
    jp: '通知',
    title: 'Notifications',
    description:
      'Problems the server told you about that are still there, and the messages it sent.',
    keywords: 'problems sent log'
  },
  {
    id: 'diag-server',
    tab: 'Diagnostics',
    jp: 'サーバー',
    title: 'Server',
    keywords: 'version database'
  }
];

export const SETTINGS_CATALOG: CatalogSetting[] = [
  // Reader › Theme and display
  {
    id: 'theme',
    section: 'reader-theme',
    title: 'Theme',
    description: 'The colours of the book’s pages. Your own themes are shared with every device.',
    keywords: 'colour color custom theme'
  },
  {
    id: 'follow-system',
    section: 'reader-theme',
    title: 'Follow the device’s light or dark mode',
    description: 'Use one theme while the device is light and another while it is dark.',
    keywords: 'dark mode system'
  },
  {
    id: 'light-theme',
    section: 'reader-theme',
    title: 'Theme while the device is light',
    description: 'Picking one also switches the reader right away while the device is light.',
    parent: 'follow-system'
  },
  {
    id: 'dark-theme',
    section: 'reader-theme',
    title: 'Theme while the device is dark',
    description: 'Picking one also switches the reader right away while the device is dark.',
    parent: 'follow-system'
  },
  {
    id: 'eink',
    section: 'reader-theme',
    title: 'E-ink mode',
    description:
      'This device only: pure black on white everywhere, without grays, shadows or animations. The book ignores the theme while it is on.',
    keywords: 'boox epaper'
  },
  {
    id: 'library-look',
    section: 'library-appearance',
    title: 'Library look',
    description:
      'Light or dark for Home, Library, Collections, Notes and Stats. “Like the book” turns dark when the book’s theme is dark (also when it follows the device). E-ink always wins.',
    keywords: 'dark'
  },
  {
    id: 'wake-lock',
    section: 'reader-theme',
    title: 'Keep the screen on while reading',
    description:
      'Asks the browser to stop the screen from dimming or locking while a book is open.',
    keywords: 'wake lock sleep'
  },
  // Reader › Fonts
  {
    id: 'font-main',
    section: 'reader-fonts',
    title: 'Main font',
    description: 'Used where the book asks for a serif (mincho) font, which is most of the text.',
    keywords: 'font family group 1 serif mincho'
  },
  {
    id: 'font-sans',
    section: 'reader-fonts',
    title: 'Sans-serif font',
    description: 'Used where the book asks for a sans-serif (gothic) font.',
    keywords: 'font family group 2 gothic'
  },
  {
    id: 'custom-fonts',
    section: 'reader-fonts',
    title: 'Custom fonts',
    description:
      'Add a font file or a Google font once on the library server; every device gets it and keeps it for reading offline. Each device picks its own fonts above.',
    keywords: 'google fonts upload manage'
  },
  // Reader › Text layout
  {
    id: 'justify',
    section: 'reader-text',
    title: 'Justify text',
    description: 'Lines end flush with both edges of the text.',
    keywords: 'justification'
  },
  {
    id: 'pretty-wrap',
    section: 'reader-text',
    title: 'Balanced line breaks',
    description: 'Avoids a very short last line in a paragraph, where the browser supports it.',
    keywords: 'pretty text wrap'
  },
  {
    id: 'prioritize-styles',
    section: 'reader-text',
    title: 'Use my layout over the book’s',
    description:
      'Makes your margins and justification win when the book’s own styles set them differently.',
    keywords: 'prioritize reader styles important'
  },
  {
    id: 'paragraph-spacing',
    section: 'reader-text',
    title: 'Paragraph spacing',
    description: 'Auto keeps the book’s spacing; Manual adds your own around each paragraph.',
    keywords: 'margin mode'
  },
  {
    id: 'paragraph-margins',
    section: 'reader-text',
    title: 'Space around paragraphs',
    description: 'In rem (the size of one character).',
    keywords: 'paragraph margins',
    parent: 'paragraph-spacing'
  },
  {
    id: 'page-columns',
    section: 'reader-text',
    title: 'Columns',
    description: 'How many columns of text a page shows.',
    keywords: 'page columns'
  },
  {
    id: 'avoid-page-break',
    section: 'reader-text',
    title: 'Keep words and sentences on one page',
    description: 'Moves a word or sentence to the next page instead of splitting it across two.',
    keywords: 'avoid page break'
  },
  {
    id: 'font-kerning',
    section: 'reader-text',
    title: 'Font kerning',
    description:
      'Can balance the spacing of vertical text better, if the font and browser support it.'
  },
  {
    id: 'font-vpal',
    section: 'reader-text',
    title: 'Proportional spacing (VPAL)',
    description: 'Can give vertical text more natural spacing, if the font and browser support it.'
  },
  {
    id: 'text-orientation',
    section: 'reader-text',
    title: 'Latin letters and numbers',
    keywords: 'text orientation upright mixed sideways'
  },
  // Reader › Turning pages
  {
    id: 'tap-to-flip',
    section: 'reader-pages',
    title: 'Tap the edges to turn pages',
    description:
      'Keeps a narrow strip at the left and right of the page that turns it when tapped.',
    keywords: 'tap flip margin'
  },
  {
    id: 'swipe-threshold',
    section: 'reader-pages',
    title: 'Swipe distance',
    description: 'How far a swipe must go to turn the page.',
    keywords: 'swipe threshold touch'
  },
  {
    id: 'mouse-drag',
    section: 'reader-pages',
    title: 'Drag with the mouse to turn pages',
    description: 'Drag sideways to turn the page. A drag that selects text only selects it.'
  },
  {
    id: 'mouse-drag-distance',
    section: 'reader-pages',
    title: 'Drag distance',
    description: 'How far the mouse must move sideways.',
    parent: 'mouse-drag'
  },
  {
    id: 'mouse-wheel',
    section: 'reader-pages',
    title: 'Turn pages with the mouse wheel',
    description: 'Off: the wheel doesn’t turn pages.',
    keywords: 'disable wheel navigation scroll'
  },
  {
    id: 'auto-position',
    section: 'reader-pages',
    title: 'Keep my place when the window resizes',
    description: 'After a resize, scrolls back to the text you were reading.',
    keywords: 'auto position resize'
  },
  // Reader › Bottom bar
  {
    id: 'show-chars',
    section: 'reader-bar',
    title: 'Characters read in the book',
    keywords: 'character counter footer'
  },
  {
    id: 'show-percent',
    section: 'reader-bar',
    title: 'Percentage of the book',
    keywords: 'progress footer'
  },
  {
    id: 'show-chapter-chars',
    section: 'reader-bar',
    title: 'Characters read in the chapter',
    keywords: 'footer chapter'
  },
  {
    id: 'show-chapter-percent',
    section: 'reader-bar',
    title: 'Percentage of the chapter',
    keywords: 'footer chapter'
  },
  // Reader › Your place
  {
    id: 'auto-save',
    section: 'reader-place',
    title: 'Save my place automatically',
    description: 'Saves your place when you stop turning pages or scrolling.',
    keywords: 'auto bookmark'
  },
  {
    id: 'auto-save-time',
    section: 'reader-place',
    title: 'Save after',
    description: 'Without turning pages or scrolling.',
    parent: 'auto-save'
  },
  {
    id: 'manual-save',
    section: 'reader-place',
    title: 'Only save my place by hand',
    description:
      'Leaving the book from the menu doesn’t save your place; only Save my place (B) does.',
    keywords: 'manual bookmark'
  },
  {
    id: 'selection-place',
    section: 'reader-place',
    title: 'Save the place of selected text',
    description:
      'Save my place (B) saves the paragraph near the selected text instead of the top of the page.',
    keywords: 'selection bookmark'
  },
  {
    id: 'custom-point',
    section: 'reader-place',
    title: 'Custom reading line',
    description:
      'A line on the screen you set, from which your progress and saved place are measured.',
    keywords: 'custom reading point'
  },
  {
    id: 'reset-point',
    section: 'reader-place',
    title: 'Reading line',
    description: 'Puts the line back where it started.',
    parent: 'custom-point'
  },
  {
    id: 'confirm-close',
    section: 'reader-place',
    title: 'Ask before closing with unsaved changes',
    description: 'Asks before a book tab is closed or reloaded while it has unsaved changes.',
    keywords: 'close confirmation'
  },
  {
    id: 'jump-history',
    section: 'reader-place',
    title: 'Places to remember after jumps',
    description:
      'How many places Back ([) and Forward (]) remember after jumps: search, contents, saved place, bookmarks, highlights, Jump and Continue there.',
    keywords: 'jump history back forward'
  },
  // Reader › Opening books
  {
    id: 'app-open',
    section: 'reader-opening',
    title: 'When the app opens',
    description: 'Go straight back into the book you were reading, or show Home.',
    keywords: 'start home last book'
  },
  {
    id: 'continue-prompt',
    section: 'reader-opening',
    title: 'Offer to continue from another device',
    description:
      'For library books: asks whether to continue where another device is further along. Needs record sync.',
    keywords: 'position prompt'
  },
  {
    id: 'continue-chars',
    section: 'reader-opening',
    title: 'Only when it is ahead by at least',
    description: '0 asks for any amount.',
    parent: 'continue-prompt'
  },
  {
    id: 'settle-time',
    section: 'reader-opening',
    title: 'Ignore page changes while a book opens',
    description:
      'A library book becomes Reading on its first page turn. Page changes this soon after the previous one, while the book opens, count as loading.',
    keywords: 'reading status settle'
  },
  // Reader › Highlights
  {
    id: 'highlight-bar-any',
    section: 'reader-highlights',
    title: 'Show the highlight bar for any selection',
    description:
      'Normally the bar appears after a long-press or a mouse selection. Turn this on if it never appears on this device.'
  },
  {
    id: 'highlight-refind',
    section: 'reader-highlights',
    title: 'Find moved highlights within',
    description:
      'When a book’s file changes, a highlight whose surrounding text changed is placed again only this close to its old place. Others are kept and listed as not placed.'
  },
  // Reader › Images
  {
    id: 'blur-images',
    section: 'reader-images',
    title: 'Hide spoiler images',
    description: 'Blurs the book’s pictures so they don’t give the story away.',
    keywords: 'blur image spoiler'
  },
  {
    id: 'blur-mode',
    section: 'reader-images',
    title: 'Which pictures',
    description: 'All of them, or only those after the table of contents.',
    parent: 'blur-images'
  },
  {
    id: 'illustrations-position',
    section: 'library-book-page',
    title: 'Illustrations on the book page',
    description:
      'This device only: where a book’s page in the Library shows its illustrations. Hidden pictures follow Hide spoiler images.'
  },
  // Reader › Pacer
  {
    id: 'pacer-eink-step',
    section: 'reader-pacer',
    title: 'E-ink steps',
    description:
      'This device only. In E-ink mode the pacer moves a sentence or a line at a time instead of smoothly.'
  },
  {
    id: 'pacer-lookup-resume',
    section: 'reader-pacer',
    title: 'Wait after a dictionary lookup',
    description:
      'The pacer waits while a dictionary popup is open and goes on this long after it closes. 0: it stays paused until you start it again.'
  },
  {
    id: 'pacer-idle',
    section: 'reader-pacer',
    title: 'Pause after no input',
    description:
      'Pauses after this long without a touch, key or mouse. It can’t tell reading from not reading, so it also pauses while you read hands-free. 0: never.'
  },
  {
    id: 'pacer-textless',
    section: 'reader-pacer',
    title: 'Pages without text',
    description:
      'On a page with only an illustration, turns the page after this long (when the pacer turns pages by itself).'
  },
  // Reader › Read aloud (its bottom-bar button is under Reader › Toolbars)
  {
    id: 'read-aloud-ahead',
    section: 'reader-readaloud',
    title: 'Read ahead',
    description:
      'How much audio the PC prepares ahead of what is playing. More bridges short gaps but makes the PC read sentences you may skip.'
  },
  {
    id: 'read-aloud-lookup-resume',
    section: 'reader-readaloud',
    title: 'Wait after a dictionary lookup',
    description:
      'Read-aloud pauses while a dictionary popup is open and goes on this long after it closes. 0: it stays paused until you play it again.'
  },

  // Data
  { id: 'server-address', section: 'data-server', title: 'Server', keywords: 'address url' },
  {
    id: 'request-timeout',
    section: 'data-server',
    title: 'Wait for the server',
    description: 'How long a request may take before it counts as failed. 0: no limit.',
    keywords: 'request timeout'
  },
  {
    id: 'server-check',
    section: 'data-server',
    title: 'Quick server check',
    description:
      'If the server doesn’t answer within this time, the Library shows the books on this device. 0: off.',
    keywords: 'offline away'
  },
  {
    id: 'disconnect',
    section: 'data-server',
    title: 'Disconnect',
    description:
      'Forgets the token on this device. To block it on the server too, run token revoke there.'
  },
  { id: 'sync-status', section: 'data-sync', title: 'Status', keywords: 'sync now last sync' },
  {
    id: 'record-sync',
    section: 'data-sync',
    title: 'Sync this device',
    description: 'Off: this device keeps saving locally but never talks to the server.',
    keywords: 'record sync'
  },
  {
    id: 'sync-debounce',
    section: 'data-sync',
    title: 'Wait after a change before syncing',
    parent: 'record-sync'
  },
  {
    id: 'sync-interval',
    section: 'data-sync',
    title: 'Check for other devices’ changes every',
    description: '0: only when something changes here.',
    parent: 'record-sync'
  },
  {
    id: 'copy-device',
    section: 'data-device',
    title: 'Copy settings from another device',
    description:
      'Brings over all of another device’s own settings in one step, for example when this device starts using a new address.'
  },
  {
    id: 'export-data',
    section: 'data-device',
    title: 'Export my data',
    description:
      'One readable file (JSON) with everything synced for you: places, statuses and times read, highlights, notes, bookmarks, collections, statistics and every device’s settings. Book and font files are not in it.',
    keywords: 'download backup json'
  },
  {
    id: 'persistent-storage',
    section: 'data-device',
    title: 'Keep this device’s data',
    description:
      'Asks the browser not to clear the books and data saved on this device when space runs low.',
    keywords: 'persistent storage quota'
  },
  {
    id: 'bulk-download-mode',
    section: 'data-downloads',
    title: 'Several files arrive as',
    description:
      'One ZIP file per download, or each file on its own (the browser may ask once to allow several downloads).',
    keywords: 'zip select multiple bulk'
  },
  {
    id: 'download-confirm-size',
    section: 'data-downloads',
    title: 'Ask before downloads larger than',
    description: '0: never ask.',
    keywords: 'size confirm gb warning'
  },
  // Library › Book page: the links (calibre-metadata-display.md)
  {
    id: 'links-placement',
    section: 'library-book-page',
    title: 'Where the links go',
    description: 'Store and book-site links on a Calibre book’s page.',
    keywords: 'links store placement section panel buttons'
  },
  {
    id: 'links-more-as',
    section: 'library-book-page',
    title: 'More opens as',
    description: 'How the More button shows the links set to Menu.',
    keywords: 'links store dropdown modal menu'
  },
  {
    id: 'links-search',
    section: 'library-book-page',
    title: 'Search links',
    description:
      'When a store has no saved id for the book, link to a search for its title and author (marked with a magnifier). Off: that store isn’t shown for the book.',
    keywords: 'links store search magnifier'
  },
  {
    id: 'book-edit-as',
    section: 'library-book-page',
    title: 'Book form opens as',
    description:
      'The pencil on a Calibre book’s page opens its edit form in a side panel or a modal.',
    keywords: 'edit details pencil form side panel modal calibre'
  },
  {
    id: 'book-rating-empty',
    section: 'library-book-page',
    title: 'A book without a rating',
    description: 'The line under the byline: hidden, or “No rating”.',
    keywords: 'rating stars no rating'
  },
  {
    id: 'series-edit-as',
    section: 'library-editing',
    title: 'Series editor opens as',
    description: 'Edit series (on a series page) in a side panel or a modal. This device only.',
    keywords: 'edit series rename numbers side panel modal'
  },
  {
    id: 'tags-you-can-pick',
    section: 'library-editing',
    title: 'Tags you can pick',
    description:
      'The tags the edit form offers, and the list the cleanup’s tagging of new books picks from. Changing this list writes nothing to your books: they keep the tags they have. One list for every device.',
    keywords: 'tags genres list vocabulary your tags cleanup new books'
  },
  {
    id: 'epub-fixes',
    section: 'data-import',
    title: 'Fix EPUB files on import',
    keywords: 'epub import fixes html'
  },
  {
    id: 'restrict-links',
    section: 'data-import',
    title: 'Only fix links',
    description: 'Applies the fix for wrongly closed elements to links only.',
    parent: 'epub-fixes'
  },
  {
    id: 'migration',
    section: 'data-tools',
    title: 'Migration from the old sync',
    description:
      'The one-time move of books, places and statistics from the old file sync to the library server, and its check page.'
  },
  {
    id: 'cleanup',
    section: 'data-tools',
    title: 'Calibre library cleanup',
    description:
      'Removes duplicate copies from the Calibre library and fixes metadata, in batches you can undo. Off until you turn it on there.'
  },

  // Statistics
  {
    id: 'day-start',
    section: 'stats-days',
    title: 'Day starts at',
    description:
      'Reading before this time counts for the previous day. Applies to reading recorded from now on; days from before device tracking keep their date.'
  },
  {
    id: 'week-start',
    section: 'stats-days',
    title: 'Week starts on',
    description: 'Used by the Stats page and weekly goals.'
  },
  {
    id: 'stats-enabled',
    section: 'stats-tracker',
    title: 'Track reading time',
    description:
      'Shows the tracker button in the reader’s bottom-left corner. Tap it to start or pause a session.',
    keywords: 'statistics enable tracker'
  },
  {
    id: 'auto-pause',
    section: 'stats-tracker',
    title: 'Pause by itself',
    keywords: 'tracker auto pause',
    parent: 'stats-enabled'
  },
  {
    id: 'popup-detection',
    section: 'stats-tracker',
    title: 'Keep running while a dictionary popup is open',
    description:
      'For Yomitan and jpdb-browser-reader popups. Off: the tracker pauses while one is open. With Yomitan’s “Use a secure container around popups” on (its default), a lookup made while text is selected isn’t seen.',
    keywords: 'dictionary detection yomitan',
    parent: 'stats-enabled'
  },
  {
    id: 'idle-time',
    section: 'stats-tracker',
    title: 'Pause when idle',
    description:
      'Pauses after this long without a page turn or scroll; the next one resumes it. 0: never (12 hours at most).',
    keywords: 'idle',
    parent: 'stats-enabled'
  },
  {
    id: 'idle-rollback',
    section: 'stats-tracker',
    title: 'Take the idle time back out',
    description: 'Subtracts the idle wait from the session when the tracker pauses.',
    keywords: 'rollback statistics idle',
    parent: 'stats-enabled'
  },
  {
    id: 'autostart',
    section: 'stats-tracker',
    title: 'Start on the first page turn',
    description:
      'Starts the tracker on your first page turn after opening a book; page changes in the first seconds (restoring your place, layout) are ignored until the count has been still this long. 0: off.',
    keywords: 'autostart tracker',
    parent: 'stats-enabled'
  },
  {
    id: 'long-press',
    section: 'stats-tracker',
    title: 'Hold to open the tracker menu',
    description: 'A tap pauses or resumes the tracker; holding it this long opens its menu.',
    keywords: 'long press',
    parent: 'stats-enabled'
  },
  {
    id: 'open-on-done',
    section: 'stats-tracker',
    title: 'Open the tracker when a book is finished',
    parent: 'stats-enabled'
  },
  {
    id: 'add-on-done',
    section: 'stats-tracker',
    title: 'Count the rest of the book when finished',
    description:
      'Adds the characters between your place and the end of the book to the statistics.',
    keywords: 'update on completion',
    parent: 'stats-enabled'
  },
  {
    id: 'custom-point-pause',
    section: 'stats-tracker',
    title: 'Pause while setting the reading line',
    description: 'Pauses the tracker while you move the custom reading line, and resumes it after.',
    keywords: 'custom point pauses tracker',
    parent: 'stats-enabled'
  },
  {
    id: 'forward-skip',
    section: 'stats-skipping',
    title: 'Forward jump',
    description: 'Moving forward more than this between two ticks counts as a jump. 0: off.',
    keywords: 'skip threshold'
  },
  {
    id: 'backward-skip',
    section: 'stats-skipping',
    title: 'Backward jump',
    description: 'Moving back more than this between two ticks counts as a jump. 0: off.',
    keywords: 'skip threshold'
  },
  {
    id: 'skip-action',
    section: 'stats-skipping',
    title: 'After a jump',
    description: 'Ignore it, or pause the tracker.',
    keywords: 'threshold action'
  },
  {
    id: 'speed-goal-min',
    section: 'stats-goals',
    title: 'A speed goal counts after',
    description:
      'A speed goal counts for a day, week or month only after this much tracked reading in it.'
  },
  {
    id: 'time-left',
    section: 'stats-bar',
    title: 'Time left',
    description:
      'This device only. How long the chapter or the book will take at your recent speed in the book.'
  },
  {
    id: 'time-left-recent',
    section: 'stats-bar',
    title: 'Based on your newest reading',
    description: 'Time left uses this much of your newest reading in the book.',
    parent: 'time-left'
  },
  {
    id: 'time-left-min',
    section: 'stats-bar',
    title: 'Use your overall speed below',
    description:
      'With less reading than this in a book, time left uses your overall speed instead.',
    parent: 'time-left'
  },
  {
    id: 'on-track-dot',
    section: 'stats-bar',
    title: 'On-track dot',
    description:
      'This device only. A dot at the right end of the bottom bar: filled when your goals are on track, with a tick when they are met, an empty ring when one is behind. Tap it to see each goal.',
    keywords: 'goals dot'
  },
  {
    id: 'on-track-rule',
    section: 'stats-bar',
    title: 'Week and month goals',
    parent: 'on-track-dot'
  },

  // Audiobooks
  {
    id: 'audio-scan',
    section: 'audio-folder',
    title: 'Scan again',
    description:
      'New audiobooks show up after the next scan: every day, when the server starts, or now.'
  },
  {
    id: 'audio-books-list',
    section: 'audio-books',
    title: 'Linked books',
    keywords: 'audiobook list search'
  },
  { id: 'pc-state', section: 'audio-pc', title: 'The PC', keywords: 'status online' },
  {
    id: 'pc-keep-loaded',
    section: 'audio-pc',
    title: 'Keep the voice loaded',
    description:
      'After read-aloud or an Enrich clip. Loading the voice takes about 2 minutes; while it is kept, audiobooks and subtitles wait. 0 lets it go at once.'
  },
  {
    id: 'pc-pause',
    section: 'audio-pc',
    title: 'Pause the PC',
    description: 'While paused, the PC takes no new jobs; a job already running finishes.'
  },
  { id: 'pc-jobs', section: 'audio-pc', title: 'Waiting and running', keywords: 'jobs queue' },
  {
    id: 'voice-upload',
    section: 'audio-voices',
    title: 'Add your own recording',
    keywords: 'upload voice'
  },
  { id: 'voice-describe', section: 'audio-voices', title: 'Describe a voice', keywords: 'sample' },
  { id: 'pause-sentence', section: 'audio-pauses', title: 'After a sentence' },
  { id: 'pause-paragraph', section: 'audio-pauses', title: 'After a paragraph' },
  { id: 'pause-chapter', section: 'audio-pauses', title: 'After a chapter' },
  {
    id: 'pause-dialogue',
    section: 'audio-pauses',
    title: 'Between narration and dialogue',
    description:
      'Inside a sentence like 「行こう」と彼は言った。 when the dialogue has a voice of its own (also for read-aloud and Anki’s sentence audio).'
  },
  {
    id: 'speaker-unsure',
    section: 'audio-speakers',
    title: 'A speaker is unsure below',
    description:
      'Quotes whose speaker the PC was less sure of are listed under “To check” on a book’s “Check quotes” page.'
  },

  // Anki
  {
    id: 'anki-url',
    section: 'anki-connection',
    title: 'AnkiConnect address',
    keywords: 'url port'
  },
  {
    id: 'anki-key',
    section: 'anki-connection',
    title: 'AnkiConnect key',
    description: 'Only if AnkiConnect asks for one. It stays on this device.'
  },
  { id: 'anki-timeout', section: 'anki-connection', title: 'Wait for Anki' },
  {
    id: 'anki-check',
    section: 'anki-connection',
    title: 'Connect to Anki',
    description: 'Checks the address and loads your note types.'
  },
  {
    id: 'anki-auto-enrich',
    section: 'anki-enrich',
    title: 'Enrich new cards automatically',
    description:
      'When you make a card in Yomitan while reading, it gets the sentence audio, cover and link as Enrich would. A card is enriched when the sentence in its Sentence field is in the open book, so the note type needs its Sentence field set up below.',
    keywords: 'auto'
  },
  {
    id: 'anki-auto-enrich-seconds',
    section: 'anki-enrich',
    title: 'Ask Anki for new cards every',
    parent: 'anki-auto-enrich'
  },
  {
    id: 'anki-days',
    section: 'anki-enrich',
    title: 'Enrich notes added in the last',
    description: 'Enrich changes the newest note added in this time.'
  },
  {
    id: 'anki-tag-prefix',
    section: 'anki-enrich',
    title: 'Before the title tag',
    description:
      'Cards get the book’s title as a tag. For example book:: gives book::タイトル; empty gives the title alone.'
  },
  { id: 'anki-audio-max', section: 'anki-audio', title: 'Longest sentence audio' },
  {
    id: 'anki-audio-threshold',
    section: 'anki-audio',
    title: 'How closely the subtitles must match',
    description:
      'To find a sentence’s audio, its text is looked for in the subtitles. When they word it a little differently (kana instead of kanji, a missing word), the closest lines are used if they are at least this similar: 0.6 = 60 %. Higher is stricter.'
  },
  {
    id: 'anki-pc-audio',
    section: 'anki-audio',
    title: 'Sentence audio read by TTS',
    description:
      'For a book without an audiobook, the PC reads the sentence with this TTS voice, and the audio is added to the card once the PC has read it (it waits under Waiting sentence audio on the device you used). The pronunciation fixes in Audiobooks apply; a book’s page can choose its own voice.',
    keywords: 'voice model dialogue'
  },
  { id: 'anki-note-type', section: 'anki-fields', title: 'Note type' },
  {
    id: 'anki-notice-seconds',
    section: 'anki-reader',
    title: 'Close the message after',
    description: 'After enriching a card. 0 keeps it open.'
  },

  // AI
  { id: 'ai-key-anthropic', section: 'ai-keys', title: 'Anthropic API key', keywords: 'claude' },
  { id: 'ai-key-openai', section: 'ai-keys', title: 'OpenAI API key', keywords: 'gpt' },
  {
    id: 'ai-limit',
    section: 'ai-spending',
    title: 'Monthly spending limit',
    description: 'For every AI feature together. Empty: nothing is sent to a model.',
    keywords: 'budget'
  },
  { id: 'ai-month', section: 'ai-spending', title: 'This month', keywords: 'spent' },
  { id: 'ai-history', section: 'ai-spending', title: 'Earlier months', keywords: 'history' },
  {
    id: 'ai-check',
    section: 'ai-models',
    title: 'Check models',
    description: 'Asks each provider, with your key, which models it offers.'
  },
  {
    id: 'ai-add-model',
    section: 'ai-models',
    title: 'Add a model',
    description:
      'From the models Anthropic and OpenAI offer your keys, checked with one tiny test request before it is added.',
    keywords: 'new model'
  },
  {
    id: 'ai-stall',
    section: 'ai-advanced',
    title: 'Cancel an Anthropic batch with no answers after',
    description:
      "If Anthropic hasn't answered anything in a batch by then, the batch is cancelled and its questions are asked one call each. 0 = wait as long as the provider takes (up to 24 hours)."
  },
  {
    id: 'ai-stall-openai',
    section: 'ai-advanced',
    title: 'Cancel an OpenAI batch with no answers after',
    description:
      'The same for OpenAI, whose batches often take an hour or more. 0 = wait as long as OpenAI takes (up to 24 hours).'
  },
  {
    id: 'ai-flex-retries',
    section: 'ai-advanced',
    title: 'Flex: tries before the normal price',
    description:
      'A model set to Flex is asked at half price when OpenAI has room. When OpenAI refuses a call for lack of room (not charged), it is tried this many more times, then sent at the normal price.',
    keywords: 'flex service tier'
  },
  {
    id: 'ai-fail-wait',
    section: 'ai-advanced',
    title: 'Wait after a failed batch',
    description:
      'When a provider refuses a whole batch, that model sends no batch for this long, twice as long after each further failure in a row.',
    keywords: 'backoff refused batch'
  },
  {
    id: 'ai-fail-max-wait',
    section: 'ai-advanced',
    title: 'Longest wait between failing batches',
    description: 'Also how often a model whose batches are paused tries one batch.'
  },
  {
    id: 'ai-fail-pause',
    section: 'ai-advanced',
    title: 'Pause batches after failures in a row',
    description:
      "Then the model's batches are paused and a notification goes out; it ends once a batch is accepted again."
  },
  {
    id: 'ai-fail-fallback',
    section: 'ai-advanced',
    title: 'While batches are paused',
    description:
      "Wait (the model's questions wait for its batches), or ask its questions one call each for the rest of the run, at full price. The model's own setting is not changed."
  },
  {
    id: 'ai-queue-default',
    section: 'ai-advanced',
    title: 'Batch queue cap per model',
    description:
      "The most estimated prompt tokens one model may have in batches at its provider, unless its row says otherwise. Your account's real limit is on the provider's Limits page (OpenAI: enqueued tokens per model). 0 = no cap.",
    keywords: 'enqueued tokens limit'
  },
  {
    id: 'ai-turnaround',
    section: 'ai-advanced',
    title: 'Expected batch time before one is measured',
    description:
      "Only for the time left until a run's first batch comes back; after that, the measured time is used."
  },
  {
    id: 'ai-connect',
    section: 'ai-advanced',
    title: 'Wait for each address when connecting',
    description:
      'A provider can have several addresses (IPv4 and IPv6). If one takes longer than this to connect, the next is tried. Your network has no IPv6 route, so a short wait (250 ms is Node’s own) cut off the working IPv4 connection on 2026-11-19.'
  },
  {
    id: 'ai-workers',
    section: 'ai-advanced',
    title: 'Calls at the same time',
    description:
      'For a model asked one call each: how many questions run at once (a new one starts as each ends). More is faster and costs the same; past the provider’s own limit it answers “busy” and the work waits and tries again.'
  },
  {
    id: 'ai-batch-size',
    section: 'ai-advanced',
    title: 'Questions per batch',
    description: 'Providers allow up to 50,000.'
  },
  {
    id: 'ai-poll',
    section: 'ai-advanced',
    title: 'Check a batch every',
    description: 'How often the server asks a provider whether a batch is done.'
  },
  {
    id: 'ai-max-tokens',
    section: 'ai-advanced',
    title: 'Longest Claude answer',
    description:
      'Thinking included. Too low cuts answers off (8,000 starved one book in the tests); you pay only for what is written.'
  },
  {
    id: 'ai-timeout',
    section: 'ai-advanced',
    title: 'Time limit per call',
    description: 'A call that takes longer is tried again.'
  },
  {
    id: 'ai-attempts',
    section: 'ai-advanced',
    title: 'Tries per question',
    description:
      'Only when the provider is busy or has a server error. A refusal or an unusable answer is never asked again.'
  },
  {
    id: 'ai-batch-price',
    section: 'ai-advanced',
    title: 'Batch price',
    description: '0.5 = half price; used to count what batches cost.'
  },
  {
    id: 'ai-structured',
    section: 'ai-advanced',
    title: 'Ask for answers in the exact format',
    description:
      'The providers then always answer in the shape the feature reads. Turn off only if a provider refuses it.'
  },

  // Notifications
  { id: 'notify-discord', section: 'notify-channels', title: 'Discord', keywords: 'webhook' },
  {
    id: 'notify-email',
    section: 'notify-channels',
    title: 'Email (Gmail)',
    keywords: 'gmail app password'
  },
  {
    id: 'notify-digest-time',
    section: 'notify-general',
    title: 'Daily summary at',
    keywords: 'digest time'
  },
  { id: 'notify-zone', section: 'notify-general', title: 'Time zone' },
  {
    id: 'notify-link-base',
    section: 'notify-general',
    title: 'Link address',
    description: 'Messages link here, to the page where a problem is fixed.'
  },
  {
    id: 'notify-finished',
    section: 'notify-general',
    title: 'Finished jobs',
    description: 'Subtitles and audiobooks made on the PC, merges on the NAS.'
  },

  // Diagnostics
  { id: 'diag-refresh', section: 'diag-device', title: 'Refresh', keywords: 'as of' },
  { id: 'diag-open-problems', section: 'diag-notify', title: 'Open problems' },
  { id: 'diag-sent', section: 'diag-notify', title: 'Sent messages', keywords: 'log failed' },

  // Reader › Toolbars (reader toolbars session 2): one row per entry of each bar, with the
  // screen's own words (toolbar-labels.ts). The bottom bar's Anki, Read aloud and return
  // marker rows replace the old switches; their old titles are keywords, so old searches land.
  ...TOP_IDS.map((id) => ({
    id: `toolbar-top-${id}`,
    section: 'reader-toolbars',
    title: TOP_LABELS[id].name,
    description: TOP_LABELS[id].description,
    keywords: `top bar toolbar ${TOP_LABELS[id].keywords ?? ''}`.trim()
  })),
  ...BOTTOM_IDS.map((id) => ({
    id: `toolbar-bottom-${id}`,
    section: 'reader-toolbars',
    title: BOTTOM_LABELS[id].name,
    description: BOTTOM_LABELS[id].description,
    keywords: `bottom bar toolbar footer ${BOTTOM_LABELS[id].keywords ?? ''}`.trim()
  })),

  // Library › Links: one row per link, with the screen's own words (link-labels.ts).
  ...BOOK_LINKS.map((link) => ({
    id: `book-link-${link.id}`,
    section: 'library-links',
    title: link.name,
    description: LINK_LABELS[link.id].description,
    keywords: `link store ${LINK_LABELS[link.id].keywords ?? ''}`.trim()
  }))
];

const SECTION_BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]));
const SETTING_BY_ID = new Map(SETTINGS_CATALOG.map((s) => [s.id, s]));

export function catalogSection(id: string): CatalogSection | undefined {
  return SECTION_BY_ID.get(id);
}

export function catalogSetting(id: string): CatalogSetting | undefined {
  return SETTING_BY_ID.get(id);
}

/** DOM ids: a section is `s-<id>`, a row `setting-<id>`. */
export const sectionDomId = (id: string) => `s-${id}`;
export const settingDomId = (id: string) => `setting-${id}`;
