// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
//
// ttsu (Whispersync Match on the book page, 2026-11-21): whispersync's matcher, moved out of
// components/Match.svelte unchanged so the reader's Match and the book page's Match run the
// same code. `matchSubtitles` is the body of Match.svelte's onMatchSubtitles statement for
// statement; the component's stores are passed in as getters, read where the component read
// them (the similarity threshold and the ignored tags while matching, the subtitle name at the
// end), and `document` is the given `doc`. The helpers below it are the component's, unchanged.
/* eslint-disable prefer-const, no-empty, no-useless-escape -- whispersync's code as it was, statement for statement */
import type { DiffDetail, Subtitle } from './general';
import {
	allIgnoredElements,
	caluclatePercentage,
	getBaseLineCSSSelectorForId,
	getSubtitleIdFromElement,
	parseHTML,
	throwIfAborted,
} from './util';

const singleIgnoredElements = new Set(['rt']);
const normalizeRegex = /[\p{punct}\s]/u;

/** whispersync's three match settings (Match.svelte's stores), read when the matcher reads them. */
export interface MatchSettings {
	/** matchLineIgnoreRp$ */
	ignoreRp(): boolean;
	/** matchLineSimilarityThreshold$ */
	similarityThreshold(): number;
	/** matchLineMaxAttempts$ */
	maxAttempts(): number;
}

/** The reader-only start point: the tapped text and its ttu parent's id. */
export interface StartHint {
	nodeContent: string;
	parentId: string;
}

export interface MatchInput {
	/** The book's stored HTML (`$bookData$.elementHtml`). */
	elementHtml: string;
	/** The subtitle lines in order (`[...$currentSubtitles$.values()]`). */
	subtitles: Subtitle[];
	/** `$currentSubtitleFile$.name`, read at the end for the match stamp. */
	subtitleFileName: () => string;
	settings: MatchSettings;
	/** The start point, read where the component read it (undefined: none). */
	hint?: () => StartHint | undefined;
	signal: AbortSignal;
	/** The progress in % whenever it changes (the matcher then yields once). */
	onProgress?: (progress: number) => void;
	doc?: Document;
}

export interface MatchResult {
	/** The matched book (its innerHTML is what Save stores). */
	bookHTML: HTMLElement;
	matchedSubtitles: number;
	/** "<matched> / <lines> (<n>%)" */
	lineMatchRate: string;
	/** "<differing> / <matched> (<n>%)" */
	bookSubtitleDiffRate: string;
	subtitlesForDownload: Subtitle[];
	subtitleDiffDetails: DiffDetail[];
	unmatchedSubtitles: Subtitle[];
}

/**
 * Matches the subtitle lines to the book's text (Match.svelte's onMatchSubtitles). Throws as
 * it did (a cancel throws whispersync's AbortError).
 */
export async function matchSubtitles(input: MatchInput): Promise<MatchResult> {
	const { subtitles, settings, signal: cancelSignal } = input;
	const document = input.doc ?? globalThis.document;
	const hint = () => input.hint?.();
	const startHintNodeContent = () => hint()?.nodeContent;
	const startHintParentId = () => hint()?.parentId;
	const hasHintNow = () => startHintNodeContent() !== undefined && startHintParentId() !== undefined;
	const maxProgress = subtitles.length;
	const subtitlesForDownload: Subtitle[] = [];
	const subtitleDiffDetails: DiffDetail[] = [];
	const unmatchedSubtitles: Subtitle[] = [];

	// Match.svelte: `$: ignoredTags = $matchLineIgnoreRp$ ? allIgnoredElements : singleIgnoredElements`
	// and `$: ignoredTagsSelector = [...ignoredTags].join(',')`, read where they were read.
	let selectorFor: boolean | undefined;
	let selector = '';
	const ignoredTagsSelector = () => {
		const ignoreRp = settings.ignoreRp();
		if (ignoreRp !== selectorFor) {
			selectorFor = ignoreRp;
			selector = [...(ignoreRp ? allIgnoredElements : singleIgnoredElements)].join(',');
		}
		return selector;
	};

	let currentProgress = 0;
	let bookHTML: HTMLElement;

	const textNodes: Node[] = [];
	const maxMatchAttempts = Math.min(subtitles.length, settings.maxAttempts());
	const originalElementsMap = new Map<HTMLElement, string>();
	const matchedElementsMap = new Map<HTMLElement, string>();
	const allIgnoredSelector = [...allIgnoredElements].join(',');

	let currentNodes: Node[] = [];
	let currentText = '';
	let textInScope = '';
	let currentSubtitleIndex = 0;
	let passedStartNode = hasHintNow() ? false : true;
	let { currentSubtitle, currentSubtitleLength } = getSubtitleData(subtitles, currentSubtitleIndex);

	bookHTML = parseHTML(new DOMParser(), input.elementHtml);

	const bookTextWalker = document.createTreeWalker(bookHTML, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (hasHintNow() && !passedStartNode) {
				passedStartNode =
					startHintNodeContent() === node.textContent && getTTUParent(node)?.id === startHintParentId();

				if (passedStartNode) {
					node.parentElement!.dataset.ttuWhispersyncStartNode = '';
				}
			}

			if (passedStartNode) {
				const textContent = normalizeString(node.textContent);

				addNodeContentToMap(originalElementsMap, node, textContent);

				if (textContent) {
					textNodes.push(node);
				}
			}

			return NodeFilter.FILTER_ACCEPT;
		},
	});

	while (bookTextWalker.nextNode()) {}

	let matchedSubtitles = 0;
	let matchAttempt = 1;
	let currentTextNodeIndex = 0;
	let textNodeIndexAfterLastMatch = 0;
	let textNodeCount = textNodes.length;

	while (currentTextNodeIndex < textNodeCount && currentSubtitleIndex < subtitles.length) {
		throwIfAborted(cancelSignal);

		const newProgress = caluclatePercentage(currentSubtitleIndex + 1, maxProgress);

		let node = textNodes[currentTextNodeIndex];
		let nodeParent = node.parentElement!;

		if (newProgress !== currentProgress) {
			currentProgress = newProgress;
			input.onProgress?.(currentProgress);

			await new Promise((resolve) => setTimeout(resolve));
		}

		if (!nodeParent.closest(ignoredTagsSelector())) {
			currentText += node.textContent;
		}

		const currentNormalizedTextLength = getNormalizedLength(currentText);

		if (currentNormalizedTextLength >= currentSubtitleLength) {
			const textForComparison = getTextForComparison(currentText, currentSubtitleLength);
			const textForComparisonLength = [...textForComparison].length;

			let bestLineSimiliarityStartIndex = 0;
			let bestLineSimiliarityEndIndex = textForComparisonLength;
			let bestLineSimiliarityValue = getSimilarity(textForComparison, currentSubtitle);

			currentNodes.push(node);

			const similiarityResult = findBestSimilarity(
				currentSubtitle,
				currentSubtitleLength,
				textForComparison,
				textForComparisonLength,
				bestLineSimiliarityStartIndex,
				bestLineSimiliarityValue,
				currentNodes,
				textNodes,
				currentTextNodeIndex,
				settings,
				ignoredTagsSelector,
			);
			const isThresholdMet = similiarityResult.bestLineSimiliarityValue >= settings.similarityThreshold();

			if (isThresholdMet) {
				({ bestLineSimiliarityStartIndex, bestLineSimiliarityEndIndex, currentNodes, currentTextNodeIndex } =
					similiarityResult);
			}

			node = textNodes[currentTextNodeIndex];
			nodeParent = node.parentElement!;

			currentTextNodeIndex += 1;

			while (nodeParent.closest(ignoredTagsSelector()) && currentTextNodeIndex < textNodeCount) {
				node = textNodes[currentTextNodeIndex];
				nodeParent = node.parentElement!;

				if (nodeParent.closest(ignoredTagsSelector())) {
					currentNodes.push(node);
				}

				currentTextNodeIndex += 1;
			}

			currentTextNodeIndex -= 1;

			if (isThresholdMet) {
				let charactersToProcess = bestLineSimiliarityEndIndex - bestLineSimiliarityStartIndex;
				let charactersProcessed = 0;
				let hadRemainingCharacters = false;

				if (bestLineSimiliarityStartIndex !== 0) {
					const nodeToProcess = currentNodes[0];
					const nodeToProcessTextContent = nodeToProcess.textContent || '';
					const ignoredTextNode = document.createTextNode(
						[...nodeToProcessTextContent].slice(0, bestLineSimiliarityStartIndex).join(''),
					);
					const remainingTextNode = document.createTextNode(
						[...nodeToProcessTextContent].slice(bestLineSimiliarityStartIndex).join(''),
					);

					nodeToProcess.parentElement!.replaceChild(ignoredTextNode, nodeToProcess);
					ignoredTextNode.after(remainingTextNode);

					currentNodes[0] = remainingTextNode;
				}

				for (let index = 0, { length } = currentNodes; index < length; index += 1) {
					const nodeToProcess = currentNodes[index];
					const nodeToProcessParentElement = nodeToProcess.parentElement!;
					const nodeToProcessTextContent = nodeToProcess.textContent || '';
					const nodeTextContentLength = [...nodeToProcessTextContent].length;
					const isIgnoredParent = !!nodeToProcessParentElement.closest(ignoredTagsSelector());
					const matchedContainer = document.createElement('span');
					const matchedText = isIgnoredParent
						? [...nodeToProcessTextContent].slice(0).join('')
						: [...nodeToProcessTextContent].slice(0, charactersToProcess).join('');
					const matchedTextNode = document.createTextNode(matchedText);
					const matchedTextLength = [...matchedText].length;
					const remainingCharacters = nodeTextContentLength - matchedTextLength;

					if (charactersToProcess) {
						const subtitle = subtitles[currentSubtitleIndex];

						matchedContainer.classList.add(getBaseLineCSSSelectorForId(subtitle.id));

						matchedContainer.appendChild(matchedTextNode);
						nodeToProcessParentElement.replaceChild(matchedContainer, nodeToProcess);

						if (!nodeToProcessParentElement.closest(allIgnoredSelector)) {
							textInScope += matchedText;
						}
					}

					charactersProcessed += isIgnoredParent ? 0 : matchedTextLength;
					charactersToProcess = bestLineSimiliarityEndIndex - bestLineSimiliarityStartIndex - charactersProcessed;

					if (!charactersToProcess && remainingCharacters) {
						const leftOverTextNodes: Text[] = [];

						index += matchedTextLength ? 0 : 1;

						let leftOverLength = matchedTextLength;

						while (index < length) {
							const leftOverNode = currentNodes[index];
							const leftOverNodeContent = leftOverNode.textContent || '';
							const remainingTextNode = document.createTextNode(
								[...leftOverNodeContent].slice(leftOverLength).join(''),
							);

							if (!leftOverNodeContent) {
								throw new Error('charactersToProcess without remaining text found');
							}

							if (!leftOverNode.parentElement) {
								matchedContainer.after(remainingTextNode);
								leftOverTextNodes.push(remainingTextNode);
							}

							index += 1;
							leftOverLength = 0;
						}

						if (leftOverTextNodes.length) {
							textNodes.splice(currentTextNodeIndex, leftOverTextNodes.length, ...leftOverTextNodes);
						}

						hadRemainingCharacters = true;
					}
				}

				updateSubtitlesForDownload(
					subtitlesForDownload,
					subtitleDiffDetails,
					subtitles[currentSubtitleIndex],
					textInScope,
				);

				currentText = '';
				textInScope = '';

				if (!hadRemainingCharacters) {
					currentTextNodeIndex += 1;
				}

				textNodeIndexAfterLastMatch = currentTextNodeIndex;
				currentSubtitleIndex += 1;
				matchedSubtitles += 1;
				matchAttempt = 1;

				if (currentSubtitleIndex < subtitles.length) {
					({ currentSubtitle, currentSubtitleLength } = getSubtitleData(subtitles, currentSubtitleIndex));
				}
			} else {
				currentTextNodeIndex = textNodeIndexAfterLastMatch + matchAttempt;
				matchAttempt += 1;
				currentText = '';
				textInScope = '';

				const isEndReached = currentTextNodeIndex > textNodes.length;
				const maxAttemptsReached = matchAttempt > maxMatchAttempts;

				if (maxAttemptsReached || isEndReached) {
					console.log(
						maxAttemptsReached
							? `Max match attempts for ${currentSubtitle} (${subtitles[currentSubtitleIndex].id}) reached - reset`
							: `End of Text before max attempt for ${currentSubtitle} (${subtitles[currentSubtitleIndex].id}) reached - reset`,
					);

					unmatchedSubtitles.push(subtitles[currentSubtitleIndex]);

					updateSubtitlesForDownload(
						subtitlesForDownload,
						subtitleDiffDetails,
						subtitles[currentSubtitleIndex],
						textInScope,
					);

					matchAttempt = 1;
					currentSubtitleIndex += 1;

					if (currentSubtitleIndex < subtitles.length) {
						currentTextNodeIndex = textNodeIndexAfterLastMatch;

						({ currentSubtitle, currentSubtitleLength } = getSubtitleData(subtitles, currentSubtitleIndex));
					} else {
						currentTextNodeIndex = textNodeCount;
					}
				}
			}

			currentNodes = [];
		} else {
			currentNodes.push(node);
			currentTextNodeIndex += 1;
		}

		textNodeCount = textNodes.length;
	}

	passedStartNode = hasHintNow() ? false : true;

	const matchedWlker = document.createTreeWalker(bookHTML, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (hasHintNow() && !passedStartNode) {
				passedStartNode = !!node.parentElement?.closest('*[data-ttu-whispersync-start-node]');
			}

			if (passedStartNode) {
				addNodeContentToMap(matchedElementsMap, node, normalizeString(node.textContent));
			}

			return NodeFilter.FILTER_ACCEPT;
		},
	});

	while (matchedWlker.nextNode()) {}

	const bookTextEntries = [...originalElementsMap.entries()];
	const matchedBookTextEntries = [...matchedElementsMap.entries()];

	for (let index = 0, { length } = bookTextEntries; index < length; index += 1) {
		const [originalElement, originalContent] = bookTextEntries[index];
		const [matchedElement, matchedContent] = matchedBookTextEntries[index] || [];
		const ttuParent = getTTUParent(originalElement);

		if (originalElement !== matchedElement) {
			throwMatchError(`element mismatch on index ${index}`, originalElement, matchedElement, ttuParent);
		}

		const bookTextCharacters = [...originalContent];
		const matchedBookTextCharacters = [...matchedContent];

		for (let index2 = 0, { length: length2 } = bookTextCharacters; index2 < length2; index2 += 1) {
			const bookCharacter = bookTextCharacters[index2];
			const matchCharacter = matchedBookTextCharacters[index2];

			if (bookCharacter !== matchCharacter) {
				throwMatchError(
					`mismatch on index ${index}, position ${index2}: ${[...originalContent]
						.slice(Math.max(0, index2 - 10), Math.min(bookTextCharacters.length, index2 + 10))
						.join('')} | vs | ${[...matchedContent]
						.slice(Math.max(0, index2 - 10), Math.min(matchedBookTextCharacters.length, index2 + 10))
						.join('')}`,
					originalElement,
					matchedElement,
					ttuParent,
				);
			}
		}
	}

	const lastSubtitle = subtitles[subtitles.length - 1];

	if (currentText) {
		unmatchedSubtitles.push(lastSubtitle);

		console.log(`End of Text before max attempt for ${lastSubtitle.text} (${lastSubtitle.id}) reached - reset`);
	}

	if (
		subtitlesForDownload.length &&
		subtitlesForDownload[subtitlesForDownload.length - 1].id !== lastSubtitle.id
	) {
		updateSubtitlesForDownload(subtitlesForDownload, subtitleDiffDetails, lastSubtitle, textInScope);
	}

	const lineMatchRate = `${matchedSubtitles} / ${subtitles.length} (${caluclatePercentage(
		matchedSubtitles,
		subtitles.length,
		false,
	)}%)`;

	const bookSubtitleDiffRate = `${subtitleDiffDetails.length} / ${matchedSubtitles} (${caluclatePercentage(
		subtitleDiffDetails.length,
		matchedSubtitles,
		false,
	)}%)`;

	if (bookHTML.firstElementChild instanceof HTMLElement) {
		bookHTML.firstElementChild.dataset.ttuWhispersyncMatchedBy = input.subtitleFileName();
		bookHTML.firstElementChild.dataset.ttuWhispersyncMatchedOn = `${Date.now()}`;
		bookHTML.firstElementChild.dataset.ttuWhispersyncMatchedSource = 'default';
	}

	return {
		bookHTML,
		matchedSubtitles,
		lineMatchRate,
		bookSubtitleDiffRate,
		subtitlesForDownload,
		subtitleDiffDetails,
		unmatchedSubtitles,
	};
}

/** The "Download unmatched subtitle list" file's text (Match.svelte's loop). */
export function unmatchedListText(unmatchedSubtitles: Subtitle[]): string {
	let content = '';

	for (let index = 0, { length } = unmatchedSubtitles; index < length; index += 1) {
		const unmatchedSubtitle = unmatchedSubtitles[index];

		content += `${unmatchedSubtitle.id}\n${unmatchedSubtitle.text}\n\n`;
	}

	return content;
}

/** The download name for a subtitle file's unmatched lines (Match.svelte's). */
export function unmatchedListName(subtitleFileName: string): string {
	return `${subtitleFileName.split(/\.(?=[^\.]+$)/)[0]}_unmatched.txt`;
}

/**
 * The `data` row onSaveMatch stores: the row as it is (fields this code doesn't know are kept),
 * the book data over it, the text before matching as the backup, the matched text.
 */
export function matchedRow<T extends { elementHtml: string }>(
	currentData: object | undefined,
	bookData: T,
	matchedHtml: string,
	now: number,
): T & { htmlBackup: string; elementHtml: string; lastBookModified: number } {
	return {
		...currentData,
		...bookData,
		htmlBackup: bookData.elementHtml,
		elementHtml: matchedHtml,
		lastBookModified: now,
	};
}

/** The `data` row onResetBook stores: the backup back as the text, no backup. */
export function resetRow<T extends { elementHtml: string; htmlBackup?: string; lastBookModified: number }>(
	bookData: T,
	now: number,
): T {
	const next = { ...bookData, elementHtml: bookData.htmlBackup!, lastBookModified: now };

	delete next.htmlBackup;

	return next;
}

export function getTextNode(node: Node | null): Node | undefined {
	if (node === null) {
		return undefined;
	}

	if (node.nodeType === Node.TEXT_NODE && normalizeString(node.textContent)) {
		return node;
	}

	let textNode: Node | undefined;

	for (let index = 0, { length } = node.childNodes; index < length; index += 1) {
		const childNode = node.childNodes[index];

		if (childNode.nodeType === Node.TEXT_NODE && normalizeString(node.textContent)) {
			textNode = childNode;
		} else {
			textNode = getTextNode(childNode);
		}

		if (textNode) {
			break;
		}
	}

	return textNode;
}

export function getTTUParent(node: Node) {
	return node.parentElement!.closest('div[id^="ttu-"]');
}

function getSubtitleData(subtitles: Subtitle[], index: number) {
	const currentSubtitle = subtitles[index].text;
	const currentSubtitleLength = [...currentSubtitle].length;

	return { currentSubtitle, currentSubtitleLength };
}

function getNormalizedLength(value: string) {
	return [...normalizeString(value)].length;
}

export function normalizeString(value: string | null, toLowerCase = false) {
	const cleanValue = (value || '').replace(/\s/g, '').trim();

	return toLowerCase ? cleanValue.toLowerCase() : cleanValue;
}

function addNodeContentToMap(map: Map<HTMLElement, string>, node: Node, textContent: string) {
	const parent =
		node.parentElement instanceof HTMLSpanElement && getSubtitleIdFromElement(node.parentElement) !== 'not existing'
			? node.parentElement.parentElement!
			: node.parentElement!;

	map.set(parent, `${map.get(parent) || ''}${textContent}`);
}

function getTextForComparison(currentText: string, targetLength: number) {
	const characters = [...currentText];

	if (characters.length === targetLength) {
		return currentText;
	}

	let textForComparison = '';
	let textForComparisonLength = 0;

	for (let index = 0, { length } = characters; index < length; index += 1) {
		let character = characters[index];

		textForComparison += character;

		const trimmedCharacter = character.trim();

		if (trimmedCharacter && !normalizeRegex.test(trimmedCharacter)) {
			textForComparisonLength += 1;
		}

		if (textForComparisonLength === targetLength) {
			break;
		}
	}

	return textForComparison;
}

function getSimilarity(str1: string, str2: string) {
	const string1 = normalizeString(str1, true);
	const string2 = normalizeString(str2, true);
	const string1Length = [...string1].length;
	const string2Length = [...string2].length;
	const substringLength = string1Length < 5 ? 1 : 2;

	if (string1 === string2) {
		return 1;
	}

	if (string1Length < substringLength || string2Length < substringLength) {
		return 0;
	}

	const map = new Map();

	for (let i = 0; i < string1Length - (substringLength - 1); i += 1) {
		const substring1 = [...string1].slice(i, i + substringLength).join('');

		map.set(substring1, map.has(substring1) ? map.get(substring1) + 1 : 1);
	}

	let match = 0;

	for (let j = 0; j < string2Length - (substringLength - 1); j++) {
		const substring2 = [...string2].slice(j, j + substringLength).join('');
		const count = map.has(substring2) ? map.get(substring2) : 0;

		if (count > 0) {
			map.set(substring2, count - 1);

			match += 1;
		}
	}

	return (match * 2) / (string1Length + string2Length - (substringLength - 1) * 2);
}

function findBestSimilarity(
	currentSubtitle: string,
	currentSubtitleLength: number,
	textForComparison: string,
	textForComparisonLength: number,
	currentBestStartIndex: number,
	currentBestValue: number,
	currentNodes: Node[],
	textNodes: Node[],
	currentTextNodeIndex: number,
	settings: MatchSettings,
	ignoredTagsSelector: () => string,
): {
	bestLineSimiliarityStartIndex: number;
	bestLineSimiliarityEndIndex: number;
	bestLineSimiliarityValue: number;
	currentNodes: Node[];
	currentTextNodeIndex: number;
} {
	let bestLineSimiliarityStartIndex = currentBestStartIndex;
	let bestLineSimiliarityEndIndex = textForComparisonLength;
	let bestLineSimiliarityValue = currentBestValue;

	if (bestLineSimiliarityValue !== 1) {
		for (let index = bestLineSimiliarityEndIndex; index > currentBestStartIndex; index -= 1) {
			if (
				normalizeString(currentSubtitle) ===
				normalizeString([...textForComparison].slice(currentBestStartIndex, index).join(''))
			) {
				bestLineSimiliarityStartIndex = currentBestStartIndex;
				bestLineSimiliarityEndIndex = index;
				bestLineSimiliarityValue = 1;
				break;
			}
		}
	}

	if (bestLineSimiliarityValue !== 1) {
		for (let index = currentBestStartIndex; index < bestLineSimiliarityEndIndex; index += 1) {
			const lineSimiliarityToCompare = getSimilarity(
				currentSubtitle,
				[...textForComparison].slice(index, bestLineSimiliarityEndIndex).join(''),
			);

			if (lineSimiliarityToCompare > bestLineSimiliarityValue) {
				bestLineSimiliarityStartIndex = index;
				bestLineSimiliarityEndIndex = textForComparisonLength;
				bestLineSimiliarityValue = lineSimiliarityToCompare;
			}
		}
	}

	if (
		currentBestStartIndex === bestLineSimiliarityStartIndex ||
		bestLineSimiliarityValue === 1 ||
		bestLineSimiliarityValue < settings.similarityThreshold()
	) {
		if (bestLineSimiliarityValue !== 1) {
			bestLineSimiliarityValue = -1;

			for (let index = bestLineSimiliarityEndIndex; index > currentBestStartIndex; index -= 1) {
				const lineSimiliarityToCompare = getSimilarity(
					currentSubtitle,
					[...textForComparison].slice(currentBestStartIndex, index).join(''),
				);

				if (lineSimiliarityToCompare > bestLineSimiliarityValue) {
					bestLineSimiliarityStartIndex = currentBestStartIndex;
					bestLineSimiliarityEndIndex = index;
					bestLineSimiliarityValue = lineSimiliarityToCompare;
				}
			}
		}

		if (bestLineSimiliarityValue < settings.similarityThreshold() || bestLineSimiliarityValue === 1) {
			return {
				bestLineSimiliarityStartIndex,
				bestLineSimiliarityEndIndex,
				bestLineSimiliarityValue,
				currentNodes,
				currentTextNodeIndex,
			};
		}

		const finalNodes = [];
		const originalLength = currentNodes.length;
		const targetCharacterLength = bestLineSimiliarityEndIndex - bestLineSimiliarityStartIndex;

		let characterCount = 0;

		while (characterCount < targetCharacterLength && currentNodes.length) {
			const nodeToCheck = currentNodes.shift()!;
			const nodeToCheckParent = nodeToCheck.parentElement!;

			characterCount += nodeToCheckParent.closest(ignoredTagsSelector())
				? 0
				: [...(nodeToCheck.textContent || '')].length;

			finalNodes.push(nodeToCheck);
		}

		return {
			bestLineSimiliarityStartIndex,
			bestLineSimiliarityEndIndex,
			bestLineSimiliarityValue,
			currentNodes: finalNodes,
			currentTextNodeIndex: currentTextNodeIndex - (originalLength - finalNodes.length),
		};
	}

	let sliceIndex = 0;
	let charactersSeen = 0;
	let startOffset = bestLineSimiliarityStartIndex;

	for (let index = 0, { length } = currentNodes; index < length; index += 1) {
		let nodeToCheck = currentNodes[index];
		let nodeToCheckParent = nodeToCheck.parentElement!;
		let nodeToCheckLength = nodeToCheckParent.closest(ignoredTagsSelector())
			? 0
			: [...(nodeToCheck.textContent || '')].length;

		const offsetDiff = startOffset - nodeToCheckLength;

		charactersSeen += nodeToCheckLength;
		startOffset = offsetDiff < 0 ? startOffset : offsetDiff;

		if (charactersSeen >= bestLineSimiliarityStartIndex) {
			sliceIndex = index + (charactersSeen === bestLineSimiliarityStartIndex ? 1 : 0);
			break;
		}
	}

	const newNodes = [];

	let currentText = '';
	let currentNormalizedTextLength = 0;
	let newTextNodeIndex = currentTextNodeIndex - (currentNodes.length - (sliceIndex + 1));

	while (currentNormalizedTextLength <= currentSubtitleLength && newTextNodeIndex < textNodes.length) {
		const nodeToCheck = textNodes[newTextNodeIndex];
		const nodeToCheckParent = nodeToCheck.parentElement!;

		if (!nodeToCheckParent.closest(ignoredTagsSelector())) {
			currentText += nodeToCheck.textContent;
		}

		newNodes.push(nodeToCheck);

		newTextNodeIndex += 1;
		currentNormalizedTextLength = getNormalizedLength(currentText);
	}

	newTextNodeIndex = newTextNodeIndex - 1;

	currentText = getTextForComparison(currentText, currentSubtitleLength);

	return findBestSimilarity(
		currentSubtitle,
		currentSubtitleLength,
		currentText,
		[...currentText].length,
		startOffset,
		bestLineSimiliarityValue,
		newNodes,
		textNodes,
		newTextNodeIndex,
		settings,
		ignoredTagsSelector,
	);
}

function updateSubtitlesForDownload(
	subtitlesForDownload: Subtitle[],
	subtitleDiffDetails: DiffDetail[],
	currentSubtitle: Subtitle,
	textInScope: string,
) {
	const trimmedSubtitle = normalizeString(currentSubtitle.text, true);
	const trimmedTextInScope = normalizeString(textInScope, true);

	subtitlesForDownload.push({ ...currentSubtitle });

	if (textInScope && trimmedSubtitle !== trimmedTextInScope) {
		subtitlesForDownload[subtitlesForDownload.length - 1].text = textInScope;

		subtitleDiffDetails.push({
			id: currentSubtitle.id,
			original: currentSubtitle.text,
			adjusted: textInScope,
		});
	}
}

function throwMatchError(
	error: string,
	originalElement: HTMLElement,
	matchedElement: HTMLElement,
	ttuParent: Element | null,
) {
	console.log(error, originalElement, matchedElement, ttuParent);

	throw new Error(error);
}
