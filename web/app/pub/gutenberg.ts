module Gute {

  var PAGE_SIZE = 1024;
  var TOUCH_CLICK_DIST_2 = 8 * 8;
  var BOOKMARK_LAST = 'last';

  function assert(x: boolean) {
    // ...
  }

  export class Reader {
    private _bookId: string;
    private _chunkCount: number;

    private _position: number;
    private _endPosition: number;

    private _controls: Controls;
    private _pageElem: HTMLElement;
    private _hiddenElem: HTMLElement;
    private _touchStartX: number;
    private _touchStartY: number;

    constructor(bookId: string) {
      var doc = window.document;
      this._pageElem = <HTMLElement>doc.createElement('div');
      this._pageElem.className = 'textFormat page';
      this._hiddenElem = <HTMLElement>doc.createElement('div');
      this._hiddenElem.className = 'textFormat';
      this._hiddenElem.style.setProperty('visibility', 'hidden');
      doc.body.appendChild(this._pageElem);

      // Hook up events.
      window.onkeydown = (e) => {
        this._onKeyDown(<KeyboardEvent>e);
      };
      window.onresize = (e) => {
        this._onResize();
      }; // TODO: Detect font-size/zoom change.

      this._pageElem.onmousedown = (e) => {
        var me = <MouseEvent>e;
        this._onTouchStart(me.clientX, me.clientY);
      };
      this._pageElem.onmouseup = (e) => {
        var me = <MouseEvent>e;
        this._onTouchEnd(me.clientX, me.clientY);
      };

// TODO: Define TouchEvent somewhere so we can compile this.
//      this._pageElem.addEventListener('touchstart', (e) => {
//        var te = <TouchEvent>e;
//        this._onTouchStart(te.touches[0].clientX, te.touches[0].clientY);
//      }, false);
//      this._pageElem.addEventListener('touchend', (e) => {
//        var te = <TouchEvent>e;
//        this._onTouchEnd(te.touches[0].clientX, te.touches[0].clientY);
//      }, false);

      this._controls = new Controls(this);
      this._controls.setRange(235000);  // HACK
      doc.body.appendChild(this._controls.elem());

      this._loadBook(bookId);
    }

    setColor(light: boolean): void {
      if (light) {
        this._pageElem.classList.remove('dark');
      }
      else {
        this._pageElem.classList.add('dark');
      }
    }

    _onResize(): void {
      this._setPosition(this._position);
    }

    _onKeyDown(e: KeyboardEvent): void {
      switch (e.keyCode) {
        case 32:
        {
          if (e.shiftKey) {
            this._prevPage();
          } else {
            this._nextPage();
          }
          break;
        }
        case 37:
        case 38:
        {
          this._prevPage();
          break;
        }
        case 39:
        case 40:
        {
          this._nextPage();
          break;
        }
      }
    }

    _onTouchStart(x: number, y: number): void {
      this._touchStartX = x;
      this._touchStartY = y;
    }

    _onTouchEnd(x: number, y: number): void {
      var dx = x - this._touchStartX, dy = y - this._touchStartY;

      if (dx * dx + dy * dy < TOUCH_CLICK_DIST_2) {
        var w = window.innerWidth;
        if (x < w / 4) {
          this._prevPage();
        } else if (x > w - w / 4) {
          this._nextPage();
        } else {
          this._controls.toggle();
        }
      }
    }

    _prevPage(): void {
      this._setEndPosition(this._position);
    }

    _nextPage(): void {
      this._setPosition(this._endPosition);
    }

    _setPosition(pos: number): void {
      // Keep in bounds.
      this._position = pos;
      if (this._position < 0) this._position = 0;

      // Fetch the new page
      var page = Math.floor(this._position / PAGE_SIZE);
      this._fetch(this._bookId, page, 2, (text) => {
        var offset = this._position - (page * PAGE_SIZE);
        assert(offset >= 0 && offset < PAGE_SIZE * 2);

        var words = text.split(' ');
        var wordCount = this._pageSize(words, offset, false);

        this._pageElem.style.removeProperty('height');
        this._pageElem.innerHTML = words.slice(offset, offset + wordCount).join(' ');
        this._pageElem.style.setProperty('height', (window.innerHeight - 16) + 'px');

        this._endPosition = this._position + wordCount;

        this._positionChanged();
      });
    }

    _setEndPosition(pos: number): void {
      // Keep in bounds.
      // TODO: Need a book manifest to know the upper bound.
      this._endPosition = pos;
      if (this._endPosition < 0) {
        this._setPosition(0);
        return;
      }

      // Fetch the new page
      var page = Math.floor(this._endPosition / PAGE_SIZE) - 1;
      if (page < 0) page = 0;
      this._fetch(this._bookId, page, 2, (text) => {
        var offset = this._endPosition - (page * PAGE_SIZE);
        assert(offset >= 0 && offset < PAGE_SIZE * 2);

        var words = text.split(' ');
        var wordCount = this._pageSize(words, offset, true);

        this._pageElem.style.removeProperty('height');
        this._pageElem.innerHTML = words.slice(offset - wordCount, offset).join(' ');
        this._pageElem.style.setProperty('height', (window.innerHeight - 16) + 'px');

        this._position = this._endPosition - wordCount;

        // Quick hack -- keep from showing an invisible first page.
        if (wordCount == 0) {
          this._setPosition(0);
          return;
        }

        this._positionChanged();
      });
    }

    _pageSize(words: string[], offset: number, backwards: boolean): number {
      var min = 0;
      var max: number;
      if (!backwards) {
        max = (PAGE_SIZE * 2) - offset;
      } else {
        max = offset;
      }

      var doc = window.document;
      doc.body.appendChild(this._hiddenElem);
      var wordCount = this._binarySearch(min, max, (trialSize) => {
        var start: number, end: number;
        if (!backwards) {
          start = offset;
          end = offset + trialSize;
        } else {
          start = offset - trialSize;
          end = offset;
        }
        start = this._bound(start, words.length);
        end = this._bound(end, words.length);
        var slice = words.slice(start, end);

        this._hiddenElem.innerHTML = slice.join(' ');
        var height = this._hiddenElem.offsetHeight;

        return (height > window.innerHeight - 0);
      });
      doc.body.removeChild(this._hiddenElem);
      return wordCount;
    }

    _binarySearch(min: number, max: number, fn: (number)=>boolean): number {
      var trialSize = 0;
      var lastResult = false;
      while (true) {
        if (min >= max) {
          break;
        }

        trialSize = ((min + max) / 2);
        lastResult = fn(trialSize);
        if (!lastResult) {
          min = trialSize + 1;
        } else {
          max = trialSize - 1;
        }
      }

      if (fn(min) == true) {
        --min;
      }
      return min;
    }

    _bound(x: number, size: number): number {
      if (x < 0) x = 0;
      if (x > size - 1) x = size - 1;
      return x;
    }

    _fetch(bookId: string, firstPage: number, pageCount: number, callback: (string)=>void): void {
      // If all pages are available, call back synchronously.
      var hasAllPages = true;
      for (var i = firstPage; i < firstPage + pageCount; ++i) {
        if (!this._hasCachedPage(i)) {
          hasAllPages = false;
          break;
        }
      }

      if (hasAllPages) {
        callback(this._stringTogether(firstPage, pageCount));
        return;
      }

      // Nope. Go ahead and fetch the whole range from the server.
      // TODO: This is somewhat wasteful, because we might be only missing one page.
      //       It's probably not worthwhile to optimize this perfectly, but we should at least clip the range.
      var xhr = new XMLHttpRequest();
      xhr.onreadystatechange = (e) => {
        if (xhr.readyState == 4) {
          if (xhr.status != 200) {
            this._error();
            return;
          }

          var pageArray = xhr.responseText.split('\0');
          for (var i = 0; i < pageArray.length; ++i) {
            this._cachePage(firstPage + i, pageArray[i]);
          }
          callback(this._stringTogether(firstPage, pageCount));
        }
      };
      xhr.open('GET', '/page' +
          '?bookId=' + bookId +
          '&firstPage=' + firstPage +
          '&pageCount=' + pageCount);
      xhr.send();
    }

    _error(): void {
      window.location.replace('/s/examples.html');
    }

    _stringTogether(firstPage: number, pageCount: number): string {
      var text = '';
      for (var i = firstPage; i < firstPage + pageCount; ++i) {
        text += this._getCachedPage(i);
        text += ' ';
      }
      return text;
    }

    _positionChanged(): void {
      this._controls.setPosition(this._position);
      this._storeBookmark(BOOKMARK_LAST);
    }

    _storeBookmark(name: string): void {
      window.localStorage['mark:' + name + ':' + this._bookId] = this._position;
    }

    _loadBook(bookId: string): void {
      var xhr = new XMLHttpRequest();
      xhr.onreadystatechange = (e) => {
        if (xhr.readyState == 4) {
          if (xhr.status != 200) {
            this._error();
            return;
          }

          var bookSummary = JSON.parse(xhr.responseText);
          this._bookId = bookId;
          this._chunkCount = bookSummary['chunkCount'];
          this._loadBookmark(BOOKMARK_LAST);
        }
      };
      xhr.open('GET', '/book' + '?bookId=' + bookId);
      xhr.send();
    }

    _loadBookmark(name: string): void {
      var stored = window.localStorage['mark:' + name + ':' + this._bookId];
      if (stored) {
        this._setPosition(parseInt(stored));
      } else {
        this._setPosition(0);
      }
    }

    _cachePage(index: number, page: string): void {
      window.localStorage['page:' + index + ':' + this._bookId] = page;
    }

    _hasCachedPage(index: number): boolean {
      return window.localStorage['page:' + index + ':' + this._bookId] != null;
    }

    _getCachedPage(index: number): string {
      return window.localStorage['page:' + index + ':' + this._bookId];
    }
  }

  class Controls {
    private _reader: Reader;

    private _elem: HTMLElement;
    private _colorButton: HTMLButtonElement;
    private _positionText: HTMLInputElement;
    private _slider: HTMLInputElement;

    private _hidden = false;
    private _light = false;
    private _position: number;
    private _range: number;

    constructor(reader: Reader) {
      this._reader = reader;

      var doc = window.document;
      this._elem = <HTMLElement>doc.createElement('div');
      this._elem.className = 'controls';

      this._colorButton = <HTMLButtonElement>doc.createElement('button');
      this._colorButton.className = 'colorButton';
      this._colorButton.onclick = (e) => {
        this.toggleColor();
      };
      this.toggleColor();
      this._elem.appendChild(this._colorButton);

      this._positionText = <HTMLInputElement>doc.createElement('input');
      this._positionText.type = 'text';
      this._positionText.className = 'positionText';
      this._positionText.onchange = (e) => {
        this._onPosText();
      };
      this._elem.appendChild(this._positionText);

      this._slider = <HTMLInputElement>doc.createElement('input');
      this._slider.type = 'range';
      this._slider.className = 'slider';
      this._slider.onchange = (e) => {
        this._onSlide();
      };
      this._elem.appendChild(this._slider);

      this.toggle();
    }

    elem(): HTMLElement {
      return this._elem;
    }

    setRange(range: number): void {
      this._range = range;
      this._slider.max = '' + range;
    }

    setPosition(pos: number): void {
      this._position = pos;
      this._positionText.value = '' + this._position;
      this._slider.value = '' + this._position;
    }

    toggleColor(): void {
      this._light = !this._light;
      this._colorButton.textContent = this._light ? 'light' : 'dark';
      this._reader.setColor(this._light);
    }

    toggle(): void {
      this._hidden = !this._hidden;
      this._elem.style.setProperty('display', this._hidden ? 'none' : '');
    }

    _onPosText(): void {
      var pos = parseInt(this._positionText.value);
      if (!isNaN(pos)) {
        this._reader._setPosition(pos);
      }
    }

    _onSlide(): void {
      this._reader._setPosition(this._slider.valueAsNumber);
    }
  }
}

// TODO: Need to find a way to ensure the fonts are loaded before we start trying to measure.
// Otherwise, the first page can render slightly off, usually cutting off a bit of text.
var bookId = window.location.hash.substring(1);
new Gute.Reader(bookId);
