var Gute;
(function (Gute) {
    var PAGE_SIZE = 0x10000;
    var TOUCH_CLICK_DIST_2 = 8 * 8;
    var BOOKMARK_LAST = 'last';

    function assert(x) {
        // ...
    }

    var Reader = (function () {
        function Reader(bookId) {
            var _this = this;
            var doc = window.document;
            this._pageElem = doc.createElement('div');
            this._pageElem.className = 'textFormat page';
            this._hiddenElem = doc.createElement('div');
            this._hiddenElem.className = 'textFormat';
            this._hiddenElem.style.setProperty('visibility', 'hidden');
            doc.body.appendChild(this._pageElem);

            // Hook up events.
            window.onkeydown = function (e) {
                _this._onKeyDown(e);
            };
            window.onresize = function (e) {
                _this._onResize();
            };

            this._pageElem.onmousedown = function (e) {
                var me = e;
                _this._onTouchStart(me.clientX, me.clientY);
            };
            this._pageElem.onmouseup = function (e) {
                var me = e;
                _this._onTouchEnd(me.clientX, me.clientY);
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
            this._controls.setRange(235000);
            doc.body.appendChild(this._controls.elem());

            this._loadBook(bookId);
        }
        Reader.prototype.setColor = function (light) {
            if (light) {
                this._pageElem.classList.remove('dark');
            } else {
                this._pageElem.classList.add('dark');
            }
        };

        Reader.prototype._onResize = function () {
            this._setPosition(this._position);
        };

        Reader.prototype._onKeyDown = function (e) {
            switch (e.keyCode) {
                case 32: {
                    if (e.shiftKey) {
                        this._prevPage();
                    } else {
                        this._nextPage();
                    }
                    break;
                }
                case 37:
                case 38: {
                    this._prevPage();
                    break;
                }
                case 39:
                case 40: {
                    this._nextPage();
                    break;
                }
            }
        };

        Reader.prototype._onTouchStart = function (x, y) {
            this._touchStartX = x;
            this._touchStartY = y;
        };

        Reader.prototype._onTouchEnd = function (x, y) {
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
        };

        Reader.prototype._prevPage = function () {
            this._setEndPosition(this._position);
        };

        Reader.prototype._nextPage = function () {
            this._setPosition(this._endPosition);
        };

        Reader.prototype._setPosition = function (pos) {
            var _this = this;
            // Keep in bounds.
            this._position = pos;
            if (this._position < 0)
                this._position = 0;

            // Fetch the new page
            var page = Math.floor(this._position / PAGE_SIZE);
            this._fetch(this._bookId, page, 2, function (text) {
                var offset = _this._position - (page * PAGE_SIZE);
                assert(offset >= 0 && offset < PAGE_SIZE * 2);

                var words = text.split(' ');
                var wordCount = _this._pageSize(words, offset, false);

                _this._pageElem.style.removeProperty('height');
                _this._pageElem.innerHTML = words.slice(offset, offset + wordCount).join(' ');
                _this._pageElem.style.setProperty('height', (window.innerHeight - 16) + 'px');

                _this._endPosition = _this._position + wordCount;

                _this._positionChanged();
            });
        };

        Reader.prototype._setEndPosition = function (pos) {
            var _this = this;
            // Keep in bounds.
            // TODO: Need a book manifest to know the upper bound.
            this._endPosition = pos;
            if (this._endPosition < 0) {
                this._setPosition(0);
                return;
            }

            // Fetch the new page
            var page = Math.floor(this._endPosition / PAGE_SIZE) - 1;
            if (page < 0)
                page = 0;
            this._fetch(this._bookId, page, 2, function (text) {
                var offset = _this._endPosition - (page * PAGE_SIZE);
                assert(offset >= 0 && offset < PAGE_SIZE * 2);

                var words = text.split(' ');
                var wordCount = _this._pageSize(words, offset, true);

                _this._pageElem.style.removeProperty('height');
                _this._pageElem.innerHTML = words.slice(offset - wordCount, offset).join(' ');
                _this._pageElem.style.setProperty('height', (window.innerHeight - 16) + 'px');

                _this._position = _this._endPosition - wordCount;

                if (wordCount == 0) {
                    _this._setPosition(0);
                    return;
                }

                _this._positionChanged();
            });
        };

        Reader.prototype._pageSize = function (words, offset, backwards) {
            var _this = this;
            var min = 0;
            var max;
            if (!backwards) {
                max = (PAGE_SIZE * 2) - offset;
            } else {
                max = offset;
            }

            var doc = window.document;
            doc.body.appendChild(this._hiddenElem);
            var wordCount = this._binarySearch(min, max, function (trialSize) {
                var start, end;
                if (!backwards) {
                    start = offset;
                    end = offset + trialSize;
                } else {
                    start = offset - trialSize;
                    end = offset;
                }
                start = _this._bound(start, words.length);
                end = _this._bound(end, words.length);
                var slice = words.slice(start, end);

                _this._hiddenElem.innerHTML = slice.join(' ');
                var height = _this._hiddenElem.offsetHeight;

                return (height > window.innerHeight - 0);
            });
            doc.body.removeChild(this._hiddenElem);
            return wordCount;
        };

        Reader.prototype._binarySearch = function (min, max, fn) {
            var trialSize;
            var lastResult;
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
        };

        Reader.prototype._bound = function (x, size) {
            if (x < 0)
                x = 0;
            if (x > size - 1)
                x = size - 1;
            return x;
        };

        Reader.prototype._fetch = function (bookId, firstPage, pageCount, callback) {
            var _this = this;
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
            xhr.onreadystatechange = function (e) {
                if (xhr.readyState == 4) {
                    if (xhr.status != 200) {
                        _this._error();
                        return;
                    }

                    var pageArray = xhr.responseText.split('\0');
                    for (var i = 0; i < pageArray.length; ++i) {
                        _this._cachePage(firstPage + i, pageArray[i]);
                    }
                    callback(_this._stringTogether(firstPage, pageCount));
                }
            };
            xhr.open('GET', '/page' + '?bookId=' + bookId + '&firstPage=' + firstPage + '&pageCount=' + pageCount);
            xhr.send();
        };

        Reader.prototype._error = function () {
            //      window.location.replace('/s/examples.html');
        };

        Reader.prototype._stringTogether = function (firstPage, pageCount) {
            var text = '';
            for (var i = firstPage; i < firstPage + pageCount; ++i) {
                text += this._getCachedPage(i);
                text += ' ';
            }
            return text;
        };

        Reader.prototype._positionChanged = function () {
            this._controls.setPosition(this._position);
            this._storeBookmark(BOOKMARK_LAST);
        };

        Reader.prototype._storeBookmark = function (name) {
            window.localStorage['mark:' + name + ':' + this._bookId] = this._position;
        };

        Reader.prototype._loadBook = function (bookId) {
            var _this = this;
            var xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function (e) {
                if (xhr.readyState == 4) {
                    if (xhr.status != 200) {
                        _this._error();
                        return;
                    }

                    var bookInfo = JSON.parse(xhr.responseText);
                    _this._bookId = bookId;
                    _this._contentType = bookInfo['contentType'];
                    _this._chunkCount = bookInfo['chunkCount'];
                    _this._loadBookmark(BOOKMARK_LAST);
                }
            };
            xhr.open('GET', '/book' + '?bookId=' + bookId);
            xhr.send();
        };

        Reader.prototype._loadBookmark = function (name) {
            var stored = window.localStorage['mark:' + name + ':' + this._bookId];
            if (stored) {
                this._setPosition(parseInt(stored));
            } else {
                this._setPosition(0);
            }
        };

        Reader.prototype._cachePage = function (index, page) {
            window.localStorage['page:' + index + ':' + this._bookId] = page;
        };

        Reader.prototype._hasCachedPage = function (index) {
            return window.localStorage['page:' + index + ':' + this._bookId] != null;
        };

        Reader.prototype._getCachedPage = function (index) {
            return window.localStorage['page:' + index + ':' + this._bookId];
        };
        return Reader;
    })();
    Gute.Reader = Reader;

    var Controls = (function () {
        function Controls(reader) {
            var _this = this;
            this._hidden = false;
            this._light = false;
            this._reader = reader;

            var doc = window.document;
            this._elem = doc.createElement('div');
            this._elem.className = 'controls';

            this._colorButton = doc.createElement('button');
            this._colorButton.className = 'colorButton';
            this._colorButton.onclick = function (e) {
                _this.toggleColor();
            };
            this.toggleColor();
            this._elem.appendChild(this._colorButton);

            this._positionText = doc.createElement('input');
            this._positionText.type = 'text';
            this._positionText.className = 'positionText';
            this._positionText.onchange = function (e) {
                _this._onPosText();
            };
            this._elem.appendChild(this._positionText);

            this._slider = doc.createElement('input');
            this._slider.type = 'range';
            this._slider.className = 'slider';
            this._slider.onchange = function (e) {
                _this._onSlide();
            };
            this._elem.appendChild(this._slider);

            this.toggle();
        }
        Controls.prototype.elem = function () {
            return this._elem;
        };

        Controls.prototype.setRange = function (range) {
            this._range = range;
            this._slider.max = '' + range;
        };

        Controls.prototype.setPosition = function (pos) {
            this._position = pos;
            this._positionText.value = '' + this._position;
            this._slider.value = '' + this._position;
        };

        Controls.prototype.toggleColor = function () {
            this._light = !this._light;
            this._colorButton.textContent = this._light ? 'light' : 'dark';
            this._reader.setColor(this._light);
        };

        Controls.prototype.toggle = function () {
            this._hidden = !this._hidden;
            this._elem.style.setProperty('display', this._hidden ? 'none' : '');
        };

        Controls.prototype._onPosText = function () {
            var pos = parseInt(this._positionText.value);
            if (!isNaN(pos)) {
                this._reader._setPosition(pos);
            }
        };

        Controls.prototype._onSlide = function () {
            this._reader._setPosition(this._slider.valueAsNumber);
        };
        return Controls;
    })();
})(Gute || (Gute = {}));

// TODO: Need to find a way to ensure the fonts are loaded before we start trying to measure.
// Otherwise, the first page can render slightly off, usually cutting off a bit of text.
var bookId = window.location.hash.substring(1);
new Gute.Reader(bookId);
//# sourceMappingURL=gutenberg.js.map
