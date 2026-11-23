<script lang="ts">
  // vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
  // ttsu (Whispersync Match on the book page): the matcher itself is in ../lib/match.ts, moved
  // out of this component unchanged; the book page's Match runs the same code.
  import Icon from './Icon.svelte';
  import type { Context, DiffDetail, Subtitle } from '../lib/general';
  import {
    bookData$,
    booksDB$,
    currentSubtitleFile$,
    currentSubtitles$,
    dialogs$,
    exportCancelController$,
    isLoading$,
    lastError$,
    settings$
  } from '../lib/stores';
  import { downloadFile } from '../lib/util';
  import {
    getTextNode,
    getTTUParent,
    matchSubtitles,
    matchedRow,
    unmatchedListName,
    unmatchedListText
  } from '../lib/match';
  import MatchDiffDialog from './MatchDiffDialog.svelte';
  import { mdiFloppy, mdiHelpCircle, mdiInformation, mdiTarget, mdiTrashCan } from '@mdi/js';
  import Popover from './Popover.svelte';
  import Progress from './Progress.svelte';
  import SettingsCheckbox from './SettingsCheckbox.svelte';
  import SettingsNumberInput from './SettingsNumberInput.svelte';
  import { createEventDispatcher, getContext } from 'svelte';

  const { isIOS } = getContext<Context>('context');
  const { matchLineIgnoreRp$, matchLineSimilarityThreshold$, matchLineMaxAttempts$ } = settings$;
  const dispatch = createEventDispatcher<{ selectHint: void; hintSelected: void }>();

  let bookHTML: HTMLElement | undefined;
  let cancelToken = new AbortController();
  let cancelSignal = cancelToken.signal;
  let currentProgress = 0;
  let maxProgress = 0;
  let lineMatchRate = 'n/a';
  let bookSubtitleDiffRate = 'n/a';
  let subtitlesForDownload: Subtitle[] = [];
  let subtitleDiffDetails: DiffDetail[] = [];
  let unmatchedSubtitles: Subtitle[] = [];
  let startHintNodeContent: string | undefined;
  let startHintParentId: string | undefined;

  $: hasHint = startHintNodeContent !== undefined && startHintParentId !== undefined;

  async function onTriggerSelectStartHint() {
    document.addEventListener('click', onSelectHintElement, { once: true, capture: false });

    dispatch('selectHint');
  }

  function onResetHint() {
    startHintNodeContent = undefined;
    startHintParentId = undefined;
  }

  function onSelectHintElement({ x, y }: MouseEvent | PointerEvent) {
    const firstTextNode = getTextNode(document.elementFromPoint(x, y));

    if (firstTextNode) {
      const ttuParent = getTTUParent(firstTextNode);

      if (ttuParent?.id) {
        startHintNodeContent = firstTextNode.textContent!;
        startHintParentId = ttuParent.id;

        firstTextNode.parentElement!.style.visibility = 'hidden';

        setTimeout(() => (firstTextNode.parentElement!.style.visibility = ''), 500);
      }
    }

    dispatch('hintSelected');
  }

  function onDownloadUnmatchedSubtitles() {
    $isLoading$ = true;

    downloadFile(
      document,
      new Blob([unmatchedListText(unmatchedSubtitles)], { type: 'text/plain;charset=utf-8' }),
      unmatchedListName($currentSubtitleFile$!.name),
      isIOS
    );

    $isLoading$ = false;
  }

  async function onMatchSubtitles() {
    $isLoading$ = true;
    $lastError$ = '';
    lineMatchRate = 'n/a';
    bookSubtitleDiffRate = 'n/a';
    subtitlesForDownload = [];
    subtitleDiffDetails = [];
    unmatchedSubtitles = [];
    maxProgress = $currentSubtitles$.size;

    try {
      const result = await matchSubtitles({
        elementHtml: $bookData$.elementHtml,
        subtitles: [...$currentSubtitles$.values()],
        subtitleFileName: () => $currentSubtitleFile$!.name,
        settings: {
          ignoreRp: () => $matchLineIgnoreRp$,
          similarityThreshold: () => $matchLineSimilarityThreshold$,
          maxAttempts: () => $matchLineMaxAttempts$
        },
        hint: () =>
          hasHint
            ? { nodeContent: startHintNodeContent!, parentId: startHintParentId! }
            : undefined,
        signal: cancelSignal,
        onProgress: (progress) => (currentProgress = progress)
      });

      bookHTML = result.bookHTML;
      subtitlesForDownload = result.subtitlesForDownload;
      subtitleDiffDetails = result.subtitleDiffDetails;
      unmatchedSubtitles = result.unmatchedSubtitles;
      lineMatchRate = result.lineMatchRate;
      bookSubtitleDiffRate = result.bookSubtitleDiffRate;
    } catch (error: any) {
      lineMatchRate = 'n/a';
      bookSubtitleDiffRate = 'n/a';
      bookHTML = undefined;
      subtitlesForDownload = [];
      subtitleDiffDetails = [];
      unmatchedSubtitles = [];

      if (!cancelToken.signal.aborted && error.name !== 'AbortError') {
        $lastError$ = `Failed to match: ${error.message}`;
      }
    }

    currentProgress = 0;
    maxProgress = 0;
    cancelToken = new AbortController();
    cancelSignal = cancelToken.signal;
    $isLoading$ = false;
  }

  function onCancelMatch() {
    if (cancelSignal.aborted) {
      return;
    }

    cancelToken.abort('user aborted');
  }

  function onDownloadSubtitles() {
    $isLoading$ = true;

    let subtitleContent = '';

    for (let index = 0, { length } = subtitlesForDownload; index < length; index += 1) {
      const subtitle = subtitlesForDownload[index];

      subtitleContent += `${subtitle.id}\n${subtitle.startTime} --> ${subtitle.endTime}\n${subtitle.text}\n\n`;
    }

    downloadFile(
      document,
      new Blob([subtitleContent], {
        type: `${isIOS ? 'text/plain' : 'application/x-subrip'};charset=utf-8`
      }),
      `${$currentSubtitleFile$!.name.split(/\.(?=[^\.]+$)/)[0]}_adjusted.srt`,
      isIOS
    );

    $isLoading$ = false;
  }

  async function onSaveMatch() {
    $isLoading$ = true;

    try {
      // Start from the row as it currently is so any field this component does
      // not know about is carried over untouched, then overlay the authoritative
      // book data. This row gets replicated back onto the external archive, so
      // dropping a field here deletes it there as well.
      const currentData = await $booksDB$.get('data', $bookData$.id);
      const newData = matchedRow(currentData, $bookData$, bookHTML!.innerHTML, Date.now());

      await $booksDB$.put('data', newData);

      // Let the page upload the matched bookdata to NAS before reloading.
      // Falls back to a plain reload if up-sync is not configured.
      document.dispatchEvent(new CustomEvent('ttu-action', { detail: { type: 'syncAndReload' } }));
    } catch ({ message }: any) {
      $lastError$ = `Failed to save data: ${message}`;

      $isLoading$ = false;
    }
  }

</script>

<div class="flex-1">
  <div class="settings-grid">
    <div>Lines to match</div>
    <div>{$currentSubtitles$.size}</div>
    <button title={hasHint ? 'Delete start hint element' : 'Select start hint element'}>
      <Icon
        path={hasHint ? mdiTrashCan : mdiTarget}
        on:click={() => (hasHint ? onResetHint() : onTriggerSelectStartHint())}
      />
    </button>
    <div>Line match rate</div>
    <div>{lineMatchRate}</div>
    <div>
      {#if !maxProgress && unmatchedSubtitles.length}
        <button title="Download unmatched subtitle list">
          <Icon path={mdiFloppy} on:click={onDownloadUnmatchedSubtitles} />
        </button>
      {/if}
    </div>
    <div>Book diff rate</div>
    <div>{bookSubtitleDiffRate}</div>
    <Popover>
      <div slot="icon">
        <Icon path={mdiHelpCircle} />
      </div>
      <div>
        Indicates # of lines which passed the similiarity check but are not equal to the book text
      </div>
    </Popover>
    {#if !maxProgress && subtitleDiffDetails.length}
      <button
        on:click={() =>
          dialogs$.add({
            component: MatchDiffDialog,
            props: { subtitleDiffDetails }
          })}
      >
        Show Diff
      </button>
      <div></div>
      <div></div>
    {/if}
    <SettingsCheckbox
      label="Ignore rp elements"
      helpText="If enabled the content of rp elements will be ignored for the similiarity check"
      targetStore$={matchLineIgnoreRp$}
    />
    <SettingsNumberInput
      label="Line similiarity %"
      helpText="Determines the % threshold for which a book text line is considered a match (1 being identical)"
      min={0.1}
      max={1}
      step={0.1}
      targetStore$={matchLineSimilarityThreshold$}
    />
    <SettingsNumberInput
      label="Line match attempts"
      helpText="Determines how many book text lines are tested before skipping the current subtitle line as unmatched"
      min={1}
      step={1}
      targetStore$={matchLineMaxAttempts$}
    />
  </div>
</div>
<div class="flex justify-end match-btns">
  {#if maxProgress}
    <button class="btn m-r-s" disabled={cancelSignal.aborted} on:click={onCancelMatch}
      >Cancel</button
    >
  {/if}
  {#if bookHTML && !maxProgress}
    <button
      class="btn m-r-s"
      disabled={!!$exportCancelController$}
      title={$exportCancelController$ ? 'Export in progress' : null}
      on:click={onSaveMatch}
    >
      Save & reload page
    </button>
  {/if}
  {#if !maxProgress && subtitleDiffDetails.length}
    <button class="btn m-r-s" on:click={onDownloadSubtitles}>Download</button>
  {/if}
  <button class="btn m-r-s" disabled={maxProgress > 0} on:click={onMatchSubtitles}>Parse</button>
  <Popover placement="top">
    <div slot="icon">
      <Icon path={mdiInformation} />
    </div>
    <div>
      By matching the subtitles to the book you can enable extra functionality like the reader menu,
      auto scroll etc.
    </div>
  </Popover>
</div>
<Progress {currentProgress} rounded margin />
