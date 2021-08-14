/*

  10ten Japanese Reader
  by Brian Birtles
  https://github.com/birchill/10ten-ja-reader

  ---

  Originally based on Rikaikun
  by Erek Speed
  http://code.google.com/p/rikaikun/

  ---

  Originally based on Rikaichan 1.07
  by Jonathan Zarate
  http://www.polarcloud.com/

  ---

  Originally based on RikaiXUL 0.4 by Todd Rudick
  http://www.rikai.com/
  http://rikaixul.mozdev.org/

  ---

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program; if not, write to the Free Software
  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA

  ---

  Please do not change or remove any of the copyrights or links to web pages
  when modifying any of the files. - Jon

*/

import type { MajorDataSeries } from '@birchill/hikibiki-data';
import Browser, { browser } from 'webextension-polyfill-ts';

import { ContentConfig } from './content-config';
import { CopyKeys, CopyType } from './copy-keys';
import {
  getEntryToCopy,
  getFieldsToCopy,
  getWordToCopy,
  Entry as CopyEntry,
} from './copy-text';
import { isEditableNode, isTopMostWindow } from './dom-utils';
import { Point } from './geometry';
import { getTextAtPoint } from './get-text';
import { SelectionMeta } from './meta';
import { mod } from './mod';
import {
  CopyState,
  hidePopup,
  isPopupVisible,
  isPopupWindow,
  PopupOptions,
  removePopup,
  renderPopup,
  setPopupStyle,
} from './popup';
import { getPopupPosition, PopupPositionMode } from './popup-position';
import { query, QueryResult } from './query';
import { isForeignObjectElement, isSvgDoc, isSvgSvgElement } from './svg';
import { getTargetElementProps, TargetProps } from './target-props';
import { TextHighlighter } from './text-highlighter';
import { TextRange, textRangesEqual } from './text-range';
import { hasReasonableTimerResolution } from './timer-precision';

export class ContentHandler {
  // This should be enough for most (but not all) entries for now.
  //
  // See https://github.com/birchill/10ten-ja-reader/issues/319#issuecomment-655545971
  // for a snapshot of the entry lengths by frequency.
  //
  // Once we have switched all databases to IndexedDB, we should investigate the
  // performance impact of increasing this further.
  private static MAX_LENGTH = 16;

  private config: ContentConfig;
  private textHighlighter: TextHighlighter;

  // Lookup tracking (so we can avoid redundant work and so we can re-render)
  private currentTextRange: TextRange | undefined;
  private currentPoint: Point | null = null;
  private currentLookupParams:
    | { text: string; wordLookup: boolean; meta?: SelectionMeta }
    | undefined;
  private currentSearchResult: QueryResult | null = null;
  private currentTargetProps: TargetProps | undefined;
  private currentDict: MajorDataSeries = 'words';

  // We keep track of the last element that was the target of a mouse move so
  // that we can popup the window later using its properties.
  private lastMouseTarget: Element | null = null;

  // Mouse tracking
  //
  // We don't show the popup when the mouse is moving at speed because it's
  // mostly distracting and introduces unnecessary work.
  private static MOUSE_SPEED_SAMPLES = 2;
  private static MOUSE_SPEED_THRESHOLD = 0.5;
  private mouseSpeedRollingSum: number = 0;
  private mouseSpeeds: number[] = [];
  private previousMousePosition: Point | null = null;
  private previousMouseMoveTime: number | null = null;
  // We disable this feature by default and only turn it on once we've
  // established that we have a sufficiently precise timer. If
  // privacy.resistFingerprinting is enabled then the timer won't be precise
  // enough for us to test the speed of the mouse.
  private hidePopupWhenMovingAtSpeed: boolean = false;

  // Keyboard support
  private kanjiLookupMode: boolean = false;

  // Used to try to detect when we are typing so we know when to ignore key
  // events.
  private typingMode: boolean = false;

  // Copy support
  private copyMode: boolean = false;
  private copyIndex: number = 0;

  // Manual positioning support
  private popupPositionMode: PopupPositionMode = PopupPositionMode.Auto;

  constructor(config: ContentConfig) {
    this.config = config;
    this.textHighlighter = new TextHighlighter();

    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onFocusIn = this.onFocusIn.bind(this);

    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('focusin', this.onFocusIn);

    hasReasonableTimerResolution().then((isReasonable) => {
      if (isReasonable) {
        this.hidePopupWhenMovingAtSpeed = true;
      }
    });
  }

  setConfig(config: Readonly<ContentConfig>) {
    // Update the style of the popup
    if (this.config && config.popupStyle !== this.config.popupStyle) {
      setPopupStyle(config.popupStyle);
    }

    // TODO: We should update the tab display if that value changes but we
    // actually need to regenerate the popup in that case since we only generate
    // the HTML for the tabs when tabDisplay is not 'none'.

    // TODO: We should probably check which keys have changed and regenerate
    // the pop-up if needed but currently you need to change tabs to tweak
    // the config so the popup probably won't be showing anyway.
    this.config = { ...config };
  }

  detach() {
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    window.removeEventListener('focusin', this.onFocusIn);

    this.clearHighlightAndHidePopup();
    this.textHighlighter.detach();
    this.copyMode = false;

    removePopup();
  }

  onMouseMove(ev: MouseEvent) {
    this.typingMode = false;

    // Ignore mouse events while buttons are being pressed.
    if (ev.buttons) {
      return;
    }

    // We don't know how to deal with anything that's not an element
    if (!(ev.target instanceof Element)) {
      return;
    }

    // Ignore mouse events on the popup window
    if (isPopupWindow(ev.target)) {
      return;
    }

    // Safari has an odd bug where it dispatches extra mousemove events
    // when you press any modifier key (e.g. Shift).
    //
    // It goes something like this:
    //
    // * Press Shift down
    // -> mousemove with shiftKey = true
    // -> keydown with shiftKey = true
    // * Release Shift key
    // -> mousemove with shiftKey = false
    // -> keyup with shiftKey = false
    //
    // We really need to ignore the first mousemove event since otherwise it
    // will completely mess up tab switching when we have the "Shift to show
    // kanji only" setting in effect.
    //
    // For now the best way we know of doing that is to just check if the
    // position has in fact changed.
    if (
      (ev.shiftKey || ev.altKey || ev.metaKey || ev.ctrlKey) &&
      this.currentPoint &&
      this.currentPoint.x === ev.clientX &&
      this.currentPoint.y === ev.clientY
    ) {
      return;
    }

    // Check if any required "hold to show keys" are held. We do this before
    // checking throttling since that can be expensive and when this is
    // configured, typically the user will have the extension more-or-less
    // permanently enabled so we don't want to add unnecessary latency to
    // regular mouse events.
    if (!this.areHoldToShowKeysDown(ev)) {
      this.clearHighlightAndHidePopup({ currentElement: ev.target });
      // Nevertheless, we still want to set the current position information so
      // that if the user presses the hold-to-show keys later we can show the
      // popup immediately.
      this.lastMouseTarget = ev.target;
      this.currentPoint = { x: ev.clientX, y: ev.clientY };
      return;
    }

    if (this.shouldThrottlePopup(ev)) {
      this.clearHighlightAndHidePopup({ currentElement: ev.target });
      return;
    }

    let dictMode: 'default' | 'kanji' = 'default';
    if (ev.shiftKey && this.config.keys.kanjiLookup.includes('Shift')) {
      this.kanjiLookupMode = ev.shiftKey;
      dictMode = 'kanji';
    }

    this.tryToUpdatePopup(
      { x: ev.clientX, y: ev.clientY },
      ev.target,
      dictMode
    );
  }

  shouldThrottlePopup(ev: MouseEvent) {
    if (!this.hidePopupWhenMovingAtSpeed) {
      return false;
    }

    let averageSpeed = 0;

    if (this.previousMousePosition && this.previousMouseMoveTime) {
      // If the events are backed up their times might be equal. Likewise, if
      // the events are more than a couple of animation frames apart either the
      // mouse stopped, or the system is backed up and the OS can't even
      // dispatch the events.
      //
      // In either case we should:
      //
      // - Update the previous mouse position and time so that when we get the
      //   *next* event we can accurately measure the speed.
      //
      // - Not throttle the popup since for some content we might always be
      //   backed up (YouTube with browser console open seems particularly bad)
      //   and its safer to just allow the popup in this case rather than risk
      //   permanently hiding it.
      //
      if (
        ev.timeStamp === this.previousMouseMoveTime ||
        ev.timeStamp - this.previousMouseMoveTime > 32
      ) {
        this.previousMousePosition = { x: ev.pageX, y: ev.pageY };
        this.previousMouseMoveTime = ev.timeStamp;
        return false;
      }

      const distance = Math.sqrt(
        Math.pow(ev.pageX - this.previousMousePosition.x, 2) +
          Math.pow(ev.pageY - this.previousMousePosition.y, 2)
      );
      const speed = distance / (ev.timeStamp - this.previousMouseMoveTime);

      this.mouseSpeeds.push(speed);
      this.mouseSpeedRollingSum += speed;

      if (this.mouseSpeeds.length > ContentHandler.MOUSE_SPEED_SAMPLES) {
        this.mouseSpeedRollingSum -= this.mouseSpeeds.shift()!;
      }

      averageSpeed = this.mouseSpeedRollingSum / this.mouseSpeeds.length;
    }

    this.previousMousePosition = { x: ev.pageX, y: ev.pageY };
    this.previousMouseMoveTime = ev.timeStamp;

    return averageSpeed >= ContentHandler.MOUSE_SPEED_THRESHOLD;
  }

  onMouseDown(ev: MouseEvent) {
    // Ignore mouse events on the popup window
    if (isPopupWindow(ev.target)) {
      return;
    }

    // Clear the highlight since it interferes with selection.
    this.clearHighlightAndHidePopup({ currentElement: ev.target as Element });
  }

  onKeyDown(ev: KeyboardEvent) {
    const textBoxInFocus =
      document.activeElement && isEditableNode(document.activeElement);

    // If the user pressed the hold-to-show key combination, show the popup
    // if possible.
    //
    // We don't do this when the there is a text box in focus because we
    // we risk interfering with the text selection when, for example, the
    // hold-to-show key is Ctrl and the user presses Ctrl+V etc.
    if (this.isHoldToShowKeysMatch(ev)) {
      ev.preventDefault();

      if (!textBoxInFocus && this.currentPoint && this.lastMouseTarget) {
        this.tryToUpdatePopup(
          this.currentPoint,
          this.lastMouseTarget,
          'default'
        );
      }
      return;
    }

    // If we got shift in combination with something else, ignore.
    //
    // We need to allow shift by itself because it is used for switching
    // dictionaries. However, if the user presses, Cmd + Shift + 3, for example,
    // we should ignore the last two keystrokes.
    //
    // TODO: We should refine this somehow so that it's possible to toggle
    // dictionaries using Shift while pressing the hold-to-show keys.
    //
    // See https://github.com/birchill/10ten-ja-reader/issues/658
    if (
      ev.shiftKey &&
      (ev.ctrlKey || ev.altKey || ev.metaKey || ev.key !== 'Shift')
    ) {
      this.typingMode = true;
      return;
    }

    // If we're not visible we should ignore any keystrokes.
    if (!this.isVisible()) {
      this.typingMode = true;
      return;
    }

    // If we're focussed on a text-editable node and in typing mode, listen to
    // keystrokes.
    if (textBoxInFocus && this.typingMode) {
      return;
    }

    if (this.handleKey(ev.key, ev.ctrlKey)) {
      // We handled the key stroke so we should break out of typing mode.
      this.typingMode = false;

      ev.stopPropagation();
      ev.preventDefault();
    } else if (textBoxInFocus) {
      // If we are focussed on a textbox and the keystroke wasn't one we handle
      // one, enter typing mode and hide the pop-up.
      if (textBoxInFocus) {
        this.clearHighlightAndHidePopup({
          currentElement: this.lastMouseTarget,
        });
        this.typingMode = true;
      }
    }
  }

  onKeyUp(ev: KeyboardEvent) {
    if (!this.kanjiLookupMode) {
      return;
    }

    if (ev.key === 'Shift') {
      this.kanjiLookupMode = false;
      ev.preventDefault();
    }
  }

  handleKey(key: string, ctrlKeyPressed: boolean): boolean {
    // Make an upper-case version of the list of keys so that we can do
    // a case-insensitive comparison. This is so that the keys continue to work
    // even when the user has Caps Lock on.
    const toUpper = (keys: string[]): string[] =>
      keys.map((key) => key.toUpperCase());
    let { keys } = this.config;
    const [
      nextDictionary,
      toggleDefinition,
      movePopupUp,
      movePopupDown,
      startCopy,
    ] = [
      toUpper(keys.nextDictionary),
      toUpper(keys.toggleDefinition),
      toUpper(keys.movePopupUp),
      toUpper(keys.movePopupDown),
      toUpper(keys.startCopy),
    ];

    const upperKey = key.toUpperCase();

    if (nextDictionary.includes(upperKey)) {
      // If we are in kanji lookup mode, ignore 'Shift' keydown events since it
      // is also the key we use to trigger lookup mode.
      if (key === 'Shift' && this.kanjiLookupMode) {
        return true;
      }
      this.showNextDictionary();
    } else if (toggleDefinition.includes(upperKey)) {
      try {
        browser.runtime.sendMessage({ type: 'toggleDefinition' });
      } catch (e) {
        console.log(
          '[10ten-ja-reader] Failed to call toggleDefinition. The page might need to be refreshed.'
        );
        return false;
      }
      this.toggleDefinition();
    } else if (movePopupDown.includes(upperKey)) {
      this.movePopup('down');
    } else if (movePopupUp.includes(upperKey)) {
      this.movePopup('up');
    } else if (
      navigator.clipboard &&
      // It's important we _don't_ enter copy mode when the Ctrl key is being
      // pressed since otherwise if the user simply wants to copy the selected
      // text by pressing Ctrl+C they will end up entering copy mode.
      !ctrlKeyPressed &&
      startCopy.includes(upperKey)
    ) {
      if (!this.copyMode) {
        this.enterCopyMode();
      } else {
        this.nextCopyEntry();
      }
    } else if (this.copyMode && key === 'Escape') {
      this.exitCopyMode();
    } else if (this.copyMode) {
      let copyType: CopyType | undefined;
      for (const copyKey of CopyKeys) {
        if (upperKey === copyKey.key.toUpperCase()) {
          copyType = copyKey.type;
          break;
        }
      }

      if (typeof copyType === 'undefined') {
        // Unrecognized key
        return false;
      }

      this.copyCurrentEntry(copyType);
    } else {
      return false;
    }

    return true;
  }

  onFocusIn(ev: FocusEvent) {
    if (this.textHighlighter.isUpdatingFocus()) {
      return;
    }

    // If we focussed on a text box, assume we want to type in it and ignore
    // keystrokes until we get another mousemove.
    this.typingMode = !!ev.target && isEditableNode(ev.target as Node);

    // If we entered typing mode clear the highlight.
    if (this.typingMode) {
      this.clearHighlightAndHidePopup({ currentElement: this.lastMouseTarget });
    }
  }

  // Test if an incoming keyboard event matches the hold-to-show key sequence
  isHoldToShowKeysMatch(ev: KeyboardEvent): boolean {
    if (!this.config.holdToShowKeys.length) {
      return false;
    }

    // Check if it is a modifier at all
    if (!['Alt', 'AltGraph', 'Control'].includes(ev.key)) {
      return false;
    }

    return this.areHoldToShowKeysDown(ev);
  }

  // Test if hold-to-show keys are set for a given a UI event
  areHoldToShowKeysDown(ev: MouseEvent | KeyboardEvent): boolean {
    if (!this.config.holdToShowKeys.length) {
      return true;
    }

    // Check if all the configured hold-to-show keys are pressed down
    const isAltGraph = ev.getModifierState('AltGraph');
    if (
      this.config.holdToShowKeys.includes('Alt') &&
      !ev.altKey &&
      !isAltGraph
    ) {
      return false;
    }
    if (this.config.holdToShowKeys.includes('Ctrl') && !ev.ctrlKey) {
      return false;
    }

    return true;
  }

  isVisible(): boolean {
    return isPopupVisible();
  }

  showNextDictionary() {
    if (this.currentPoint) {
      this.showDictionary('next');
    }
  }

  toggleDefinition() {
    this.config.readingOnly = !this.config.readingOnly;
    this.showPopup();
  }

  movePopup(direction: 'up' | 'down') {
    if (direction === 'down') {
      this.popupPositionMode =
        (this.popupPositionMode + 1) % (PopupPositionMode.End + 1);
    } else {
      this.popupPositionMode = mod(
        this.popupPositionMode - 1,
        PopupPositionMode.End + 1
      );
    }
    this.showPopup();
  }

  enterCopyMode() {
    this.copyMode = true;
    this.copyIndex = 0;
    this.showPopup();
  }

  exitCopyMode() {
    this.copyMode = false;
    this.showPopup();
  }

  nextCopyEntry() {
    this.copyIndex++;
    this.showPopup();
  }

  copyCurrentEntry(copyType: CopyType) {
    const copyEntry = this.getCopyEntry();
    if (!copyEntry) {
      return;
    }

    let textToCopy: string;

    switch (copyType) {
      case 'entry':
        textToCopy = getEntryToCopy(copyEntry, {
          kanjiReferences: this.config.kanjiReferences,
          showKanjiComponents: this.config.showKanjiComponents,
        });
        break;

      case 'tab':
        textToCopy = getFieldsToCopy(copyEntry, {
          kanjiReferences: this.config.kanjiReferences,
          showKanjiComponents: this.config.showKanjiComponents,
        });
        break;

      case 'word':
        textToCopy = getWordToCopy(copyEntry);
        break;
    }

    this.copyString(textToCopy!, copyType);
  }

  private getCopyEntry(): CopyEntry | null {
    console.assert(
      this.copyMode,
      'Should be in copy mode when copying an entry'
    );

    if (
      !this.currentSearchResult ||
      !this.currentSearchResult[this.currentDict]
    ) {
      return null;
    }

    const searchResult = this.currentSearchResult[this.currentDict]!;

    let copyIndex = this.copyIndex;
    if (searchResult.type === 'words' || searchResult.type === 'names') {
      copyIndex = copyIndex % searchResult.data.length;
    }

    if (copyIndex < 0) {
      console.error('Bad copy index');
      this.copyMode = false;
      this.showPopup();
      return null;
    }

    switch (searchResult.type) {
      case 'words':
        return { type: 'word', data: searchResult.data[copyIndex] };

      case 'names':
        return { type: 'name', data: searchResult.data[copyIndex] };

      case 'kanji':
        return { type: 'kanji', data: searchResult.data };
    }
  }

  private async copyString(message: string, copyType: CopyType) {
    let copyState = CopyState.Finished;
    try {
      await navigator.clipboard.writeText(message);
    } catch (e) {
      copyState = CopyState.Error;
      console.error('Failed to write to clipboard', e);
    }

    this.copyMode = false;
    this.showPopup({ copyState, copyType });
  }

  highlightText(length: number) {
    if (!this.currentTextRange?.length) {
      return;
    }

    this.textHighlighter.highlight({
      length,
      textRange: this.currentTextRange,
    });
  }

  async tryToUpdatePopup(
    point: Point,
    target: Element,
    dictMode: 'default' | 'kanji'
  ) {
    const textAtPoint = getTextAtPoint(point, ContentHandler.MAX_LENGTH);

    // The following is not strictly correct since if dictMode was 'kanji'
    // but is now 'default' then technically we shouldn't return early
    // since the result will likely differ.
    //
    // In practice, however, locking the result to the previously shown
    // dictionary in this case is not a problem. On the contrary it makes
    // toggling dictionaries a little less sensitive to minor mouse movements
    // and hence easier to work with.
    if (
      textRangesEqual(this.currentTextRange, textAtPoint?.textRange) &&
      dictMode === 'default'
    ) {
      return;
    }

    if (!textAtPoint) {
      this.clearHighlightAndHidePopup({ currentElement: target });
      return;
    }

    this.currentPoint = point;
    this.currentTextRange = textAtPoint?.textRange || undefined;

    this.lookupText({
      dictMode,
      meta: textAtPoint.meta,
      text: textAtPoint.text,
      targetProps: getTargetElementProps(target),
      wordLookup: !!textAtPoint.textRange,
    });
  }

  async lookupText({
    dictMode,
    meta,
    text,
    targetProps,
    wordLookup,
  }: {
    dictMode: 'default' | 'kanji';
    meta?: SelectionMeta;
    text: string;
    targetProps: TargetProps;
    wordLookup: boolean;
  }) {
    const lookupParams = { text, meta, wordLookup };
    this.currentLookupParams = lookupParams;

    // Presumably the text or dictionary has changed so break out of copy mode
    this.copyMode = false;

    let queryResult = await query(text, {
      includeRomaji: this.config.showRomaji,
      wordLookup: lookupParams.wordLookup,
    });

    // Check if we have triggered a new query or been disabled while running
    // the previous query.
    if (
      !this.currentLookupParams ||
      JSON.stringify(lookupParams) !== JSON.stringify(this.currentLookupParams)
    ) {
      return;
    }

    if (!queryResult && !meta) {
      this.clearHighlightAndHidePopup({ currentElement: this.lastMouseTarget });
      return;
    }

    // Determine the dictionary to show
    let dict: MajorDataSeries = 'words';

    if (queryResult) {
      switch (dictMode) {
        case 'default':
          if (!queryResult.words) {
            // Prefer the names dictionary if we have a names result of more
            // than one character or if we have no kanji results.
            //
            // Otherwise, follow the usual fallback order words -> kanji ->
            // names.
            dict =
              (queryResult.names && queryResult.names.matchLen > 1) ||
              !queryResult.kanji
                ? 'names'
                : 'kanji';
          }
          break;

        case 'kanji':
          if (!queryResult.kanji) {
            queryResult = null;
          } else {
            dict = 'kanji';
          }
          break;
      }

      this.currentDict = dict;
    }

    this.currentSearchResult = queryResult;
    this.currentTargetProps = targetProps;

    this.highlightTextForCurrentResult();
    this.showPopup();
  }

  showDictionary(dictToShow: 'next' | MajorDataSeries) {
    if (!this.currentSearchResult) {
      return;
    }

    let dict: MajorDataSeries;

    if (dictToShow == 'next') {
      dict = this.currentDict;

      const cycleOrder: Array<MajorDataSeries> = ['words', 'kanji', 'names'];
      let next = (cycleOrder.indexOf(this.currentDict) + 1) % cycleOrder.length;
      while (cycleOrder[next] !== this.currentDict) {
        const nextDict = cycleOrder[next];
        if (this.currentSearchResult[nextDict]) {
          dict = nextDict;
          break;
        }
        next = ++next % cycleOrder.length;
      }
    } else {
      dict = dictToShow;
    }

    if (dict === this.currentDict) {
      return;
    }

    // The user has successfully switched dictionaries. If this is the first
    // time that's happened, store the result so we don't pester the user
    // with prompts about how to change dictionaries.
    if (!this.config.hasSwitchedDictionary) {
      try {
        browser.runtime.sendMessage({ type: 'switchedDictionary' });
      } catch (e) {
        console.log(
          '[10ten-ja-reader] Failed to call switchedDictionary. The page might need to be refreshed.'
        );
      }
      // Make sure this applies immediately
      this.config.hasSwitchedDictionary = true;
    }

    this.currentDict = dict;

    this.highlightTextForCurrentResult();
    this.showPopup();
  }

  highlightTextForCurrentResult() {
    if (this.config.noTextHighlight) {
      return;
    }

    if (!this.currentSearchResult) {
      return;
    }

    const searchResult = this.currentSearchResult[this.currentDict];

    // Work out the appropriate length to highlight
    const highlightLength = Math.max(
      searchResult?.matchLen || 0,
      this.currentLookupParams?.meta?.matchLen || 0
    );

    // Check we have something to highlight
    if (highlightLength < 1) {
      return;
    }

    this.highlightText(highlightLength);
  }

  // The currentElement here is _only_ used to avoid resetting the scroll
  // position when we clear the text selection of a text box.
  //
  // That is, if we go to clear the text selection of a text box but we are
  // still interacting with that element, then we take extra steps to ensure
  // the scroll position does not change.
  clearHighlightAndHidePopup({
    currentElement = null,
  }: {
    currentElement?: Element | null;
  } = {}) {
    this.currentTextRange = undefined;
    this.currentPoint = null;
    this.lastMouseTarget = null;

    this.currentLookupParams = undefined;
    this.currentSearchResult = null;
    this.currentTargetProps = undefined;
    this.copyMode = false;

    this.textHighlighter.clearHighlight({ currentElement });

    hidePopup();
  }

  showPopup(options?: { copyState?: CopyState; copyType?: CopyType }) {
    if (!this.currentSearchResult && !this.currentLookupParams?.meta) {
      this.clearHighlightAndHidePopup({ currentElement: this.lastMouseTarget });
      return;
    }

    const doc: Document =
      this.lastMouseTarget?.ownerDocument ?? window.document;

    const popupOptions: PopupOptions = {
      accentDisplay: this.config.accentDisplay,
      copyIndex: this.copyIndex,
      copyNextKey: this.config.keys.startCopy[0] || '',
      copyState:
        options?.copyState ||
        (this.copyMode ? CopyState.Active : CopyState.Inactive),
      copyType: options?.copyType,
      dictLang: this.config.dictLang,
      dictToShow: this.currentDict,
      document: doc,
      hasSwitchedDictionary: this.config.hasSwitchedDictionary,
      kanjiReferences: this.config.kanjiReferences,
      meta: this.currentLookupParams?.meta,
      onClosePopup: () => {
        this.clearHighlightAndHidePopup({
          currentElement: this.lastMouseTarget,
        });
      },
      onShowSettings: () => {
        browser.runtime.sendMessage({ type: 'options' }).catch(() => {
          // Ignore
        });
      },
      onSwitchDictionary: (dict: MajorDataSeries) => {
        this.showDictionary(dict);
      },
      popupStyle: this.config.popupStyle,
      posDisplay: this.config.posDisplay,
      showDefinitions: !this.config.readingOnly,
      showKanjiComponents: this.config.showKanjiComponents,
      showPriority: this.config.showPriority,
      switchDictionaryKeys: this.config.keys.nextDictionary,
      tabDisplay: this.config.tabDisplay,
    };

    const popup = renderPopup(this.currentSearchResult, popupOptions);
    if (!popup) {
      this.clearHighlightAndHidePopup({ currentElement: this.lastMouseTarget });
      return;
    }

    // Position the popup
    const {
      x: popupX,
      y: popupY,
      constrainWidth,
      constrainHeight,
    } = getPopupPosition({
      doc,
      isVerticalText: !!this.currentTargetProps?.isVerticalText,
      mousePos: this.currentPoint,
      positionMode: this.popupPositionMode,
      popupSize: {
        width: popup.offsetWidth || 200,
        height: popup.offsetHeight,
      },
      targetHasTitle: !!this.currentTargetProps?.hasTitle,
    });

    if (
      isSvgDoc(doc) &&
      isSvgSvgElement(doc.documentElement) &&
      isForeignObjectElement(popup.parentElement)
    ) {
      // Set the x/y attributes on the <foreignObject> wrapper after converting
      // to document space.
      const svg: SVGSVGElement = doc.documentElement;
      const wrapper: SVGForeignObjectElement = popup.parentElement;
      wrapper.x.baseVal.value = popupX;
      wrapper.y.baseVal.value = popupY;
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const transform = svg.createSVGTransformFromMatrix(ctm.inverse());
        wrapper.transform.baseVal.initialize(transform);
      }
    } else {
      popup.style.left = `${popupX}px`;
      popup.style.top = `${popupY}px`;

      // If we are constraining the width we reach into the popup and set it on
      // the window itself. That way the popup has a chance to try to respond to
      // the width (as opposed to simply being clipped).
      if (constrainWidth) {
        const popupWindow =
          popup.shadowRoot?.querySelector<HTMLDivElement>('.window');
        if (popupWindow) {
          popupWindow.style.maxWidth = `${constrainWidth}px`;
        }
      }

      // If we are constraining the height, however, we just clip it at the
      // bottom and fade it out. That's normally fine because we'll just clip
      // the less important entries.
      if (constrainHeight) {
        popup.style.maxHeight = constrainHeight
          ? `${constrainHeight}px`
          : 'none';
        popup.style.maskImage =
          'linear-gradient(to bottom, black 99%, transparent)';
      } else {
        popup.style.maskImage = 'none';
      }
    }
  }

  // Expose the renderPopup callback so that we can test it
  _renderPopup = renderPopup;
}

declare global {
  interface Window {
    readerScriptVer?: string;
    removeReaderScript?: () => void;
  }
}

(function () {
  // Ensure the content script is not loaded twice or that an incompatible
  // version of the script is not used.
  //
  // This is only needed when we are injecting the script via executeScript
  // when running in "activeTab" mode.
  //
  // Furthermore, with regards to incompatible versions, as far as I can tell
  // Firefox will remove old versions of injected scripts when it reloads an
  // add-on. I'm not sure if that behavior is reliable across all browsers,
  // however, so for now we try our best to ensure we have the correct version
  // of the script here.
  if (window.readerScriptVer === __VERSION__) {
    return;
  } else if (
    typeof window.readerScriptVer !== 'undefined' &&
    typeof window.removeReaderScript === 'function'
  ) {
    console.log(
      '[10ten-ja-reader] Found incompatible version of script. Removing.'
    );
    try {
      window.removeReaderScript();
    } catch (e) {
      console.error(e);
    }
  }

  let contentHandler: ContentHandler | null = null;

  // Port to the background page.
  //
  // This is only used when we are running in "activeTab" mode. It serves to:
  //
  // - Provide an extra means to ensure the tab is removed from the list of
  //   enabled tabs when the tab is destroyed (in case we fail to get a pagehide
  //   event), and
  // - Ensure the background page is kept alive so long as we have an enabled
  //   tab when the background page is running as an event page.
  //
  let port: Browser.Runtime.Port | undefined;

  window.readerScriptVer = __VERSION__;
  window.removeReaderScript = () => {
    disable();
    browser.runtime.onMessage.removeListener(onMessage);
  };

  browser.runtime.onMessage.addListener(onMessage);

  // Check if we should be enabled or not.
  //
  // We don't need to do this in activeTab mode since the background page will
  // send us an 'enable' message after injecting the script.
  //
  // However, when the content script is injected using content_scripts the
  // background script might not have been initialized yet in which case this
  // will fail. However, presumably once the background script has initialized
  // it will call us if we need to be enabled.
  if (!__ACTIVE_TAB_ONLY__) {
    browser.runtime.sendMessage({ type: 'enable?' }).catch(() => {
      // Ignore
    });
  }

  function onMessage(request: any): Promise<string> {
    if (typeof request.type !== 'string') {
      return Promise.reject(
        new Error(`Invalid request: ${JSON.stringify(request.type)}`)
      );
    }

    switch (request.type) {
      case 'enable':
        console.assert(
          typeof request.config === 'object',
          'No config object provided with enable message'
        );

        const tabId: number | undefined =
          typeof request.id === 'number' ? request.id : undefined;
        enable({ tabId, config: request.config });

        return Promise.resolve('ok');

      case 'disable':
        disable();

        return Promise.resolve('ok');

      default:
        return Promise.reject(
          new Error(`Unrecognized request: ${JSON.stringify(request.type)}`)
        );
    }
  }

  function enable({
    tabId,
    config,
  }: {
    tabId?: number;
    config: ContentConfig;
  }) {
    if (contentHandler) {
      contentHandler.setConfig(config);
    } else {
      // When the extension is upgraded, we can still have the old popup
      // window hanging around so make sure to clear it.
      removePopup();
      contentHandler = new ContentHandler(config);
    }

    // If we are running in "activeTab" mode we will get passed our tab ID
    // so we can set up a Port which will allow the background script to
    // know when we disappear so it can update the browser action status.
    //
    // We only need to do that if we're the root-most frame, however.
    if (typeof tabId !== 'undefined' && isTopMostWindow() && !port) {
      try {
        port = browser.runtime.connect(undefined, {
          name: `tab-${tabId}`,
        });
      } catch (e) {
        console.error(e);
      }
    }

    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
  }

  function disable() {
    if (contentHandler) {
      contentHandler.detach();
      contentHandler = null;
    }

    if (port) {
      port.disconnect();
      port = undefined;
    }

    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('pagehide', onPageHide);
  }

  function onPageShow() {
    browser.runtime.sendMessage({ type: 'enable?' });
  }

  function onPageHide() {
    browser.runtime.sendMessage({ type: 'disabled' });
  }
})();

export default ContentHandler;
