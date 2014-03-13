package gute

import (
	"encoding/gob"
	"errors"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"
	"encoding/json"
	"strconv"
	"appengine/urlfetch"
	"appengine"
)

const (
	INDEX_NAME   = "index.gob"
	PAGE_SIZE    = 1024
	MAX_WORD_LEN = 100
	MAX_WORDS    = 100
)

type IndexEntry struct {
	Title       string
	Language    string
	Path        string
	ContentType string
}

type Index map[string]IndexEntry

type BookSummary struct {
	ContentType string
	WordCount   int
	ChunkCount  int
}

type Book struct {
	BookSummary
	Chunks []string
}

var cache map[string]*Book
var index Index

// Reads the given book from the gutenberg.lib.md.us mirror, by its
// path. The path is different from the bookId, and can only be determined
// via the index.
func readFromGutenberg(ctx appengine.Context, bookPath string) ([]byte, error) {
	log.Printf("Fetching %v from Gutenberg", bookPath)
	url := fmt.Sprintf("http://www.gutenberg.lib.md.us/%s", bookPath)
	fetcher := urlfetch.Client(ctx)
	rsp, err := fetcher.Get(url)
	if err != nil {
		return nil, err
	}
	defer rsp.Body.Close()
	return ioutil.ReadAll(rsp.Body)
}

// Takes the raw book byte stream and processes it into a Book. Performs
// all necessary mangling and formatting to make the client happy.
func processBook(raw []byte, contentType string) *Book {
	words := make([]string, PAGE_SIZE)
	wordPos := 0
	for {
		wordCount := 0
		raw, wordCount = processLine(raw, words[wordPos:])
		wordPos += wordCount
		if wordPos == PAGE_SIZE {
			break
		}
	}

	var chunkCount int = (len(words) / PAGE_SIZE) + 1

	chunks := make([]string, chunkCount)
	for i := 0; i < chunkCount; i++ {
		start := i * PAGE_SIZE
		end := (i + 1) * PAGE_SIZE
		if end > len(words) {
			end = len(words)
		}
		chunks[i] = strings.Join(words[start:end], " ")
	}

	return &Book{
		BookSummary{
			WordCount:   0, // TODO
			ChunkCount:  chunkCount,
			ContentType: contentType,
		},
		chunks,
	}
}

func processLine(raw []byte, words []string) (newRaw []byte, wordCount int) {
	runes := make([]rune, MAX_WORD_LEN)
	pos := 0
	bytePos := 0
	wordCount = 0
	max := len(raw)

	makeWord := func() bool {
		words[wordCount] = string(runes[0:bytePos])
		bytePos = 0
		wordCount++
		return wordCount == len(words)
	}

	for {
		if pos == max {
			break
		}

		r, size := utf8.DecodeRune(raw)
		pos++
		bytePos += size
		raw = raw[bytePos:]

		if r == '\r' {
			if r, size = utf8.DecodeRune(raw); r == '\n' {
				pos++
				bytePos += size
				raw = raw[bytePos:]
			}
			makeWord()
			break
		}

		runes[pos] = r
		if unicode.IsSpace(r) {
			if makeWord() {
				break
			}
		}
	}
	return raw, wordCount
}

// Reads the given book from the local cache, if it's available. If not,
// it will retrieve the book from a Gutenberg mirror, and cache it locally.
func readBook(ctx appengine.Context, bookPath string, contentType string) (*Book, error) {
	// See if we have a local copy.
	lastSlash := strings.LastIndex(bookPath, "/")
	relPath := fmt.Sprintf("gutenberg/cache/%v", bookPath[:lastSlash])
	relFile := relPath + bookPath[lastSlash:]
	log.Println(relFile)
	os.MkdirAll(relPath, 0750)

	inFile, err := os.OpenFile(relFile, os.O_RDONLY, 0)
	if err != nil {
		// Fetch from Gutenberg.
		raw, err := readFromGutenberg(ctx, bookPath)
		if err != nil {
			return nil, err
		}

		// Process it into something palatable.
		book := processBook(raw, contentType)

		// Cache it locally.
		outFile, err := os.OpenFile(relFile, os.O_CREATE|os.O_WRONLY, 0660)
		if err != nil {
			log.Printf("Error writing '%v': %v", relFile, err)
			return nil, err
		}
		gob.NewEncoder(outFile).Encode(&book)
		outFile.Close()

		// And return it.
		return book, nil
	}

	// Read the cached book.
	log.Printf("Read %v from cache", bookPath)
	var book Book
	gob.NewDecoder(inFile).Decode(&book)
	inFile.Close()
	return &book, nil
}

// GetBook retrieves the given book, by its numeric id.
// It will fetch the book from a Gutenberg mirror if necessary.
func getBook(ctx appengine.Context, bookId string) (*Book, error) {
	// Lazy-init cache
	if cache == nil {
		cache = make(map[string]*Book)
	}

	book, exists := cache[bookId]
	if !exists {
		entry, exists := index[bookId]
		if !exists {
			return nil, errors.New("Unknown book id " + bookId)
		}

		var err error
		book, err = readBook(ctx, entry.Path, entry.ContentType)
		if err != nil {
			return nil, err
		}
		cache[bookId] = book
	}
	return book, nil
}

// LoadIndex loads the Gutenberg index from disk.
func loadIndex() error {
	if index != nil {
		return nil
	}

	f, err := os.OpenFile(INDEX_NAME, os.O_RDONLY, 0)
	if err != nil {
		return err
	}

	index = make(map[string]IndexEntry)
	dec := gob.NewDecoder(f)
	err = dec.Decode(&index)
	if err != nil {
		return err
	}

	return nil
}

func (idx Index) Save() error {
	f, err := os.OpenFile(INDEX_NAME, os.O_CREATE|os.O_WRONLY, 0660)
	if err != nil {
		return err
	}

	enc := gob.NewEncoder(f)
	err = enc.Encode(idx)
	if err != nil {
		return err
	}

	err = f.Close()
	if err != nil {
		return err
	}
	return nil
}

// HTTP handler for retrieving a book's pages.
func PageHandler(w http.ResponseWriter, r *http.Request) {
	ctx := appengine.NewContext(r)

	bookId := r.URL.Query().Get("bookId")
	firstPage, _ := strconv.ParseInt(r.URL.Query().Get("firstPage"), 10, 32)
	pageCount, _ := strconv.ParseInt(r.URL.Query().Get("pageCount"), 10, 32)

	book, err := getBook(ctx, bookId)
	if err != nil {
		log.Printf("Not found: %v", bookId)
		http.NotFound(w, r)
		return
	}

	if int(firstPage) < 0 || int(firstPage) >= book.ChunkCount || int(firstPage+pageCount) > book.ChunkCount {
		log.Printf("Out of range (%v) : %v + %v of %v", bookId, firstPage, pageCount, book.ChunkCount)
		http.NotFound(w, r)
		return
	}

	w.Header().Add("Content-Type", book.ContentType)

	for i := firstPage; i < firstPage+pageCount; i++ {
		w.Write([]byte(book.Chunks[i]))
		if i < firstPage+pageCount-1 {
			w.Write([]byte("\u0000"))
		}
	}
}

// HTTP handler for retrieving a book's metadata.
func BookHandler(w http.ResponseWriter, r *http.Request) {
	ctx := appengine.NewContext(r)

	bookId := r.URL.Query().Get("bookId")

	book, err := getBook(ctx, bookId)
	if err != nil {
		log.Printf("Not found: %v", bookId)
		http.NotFound(w, r)
		return
	}

	serialized, err := json.Marshal(&book.BookSummary)

	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	w.Header().Add("Content-Type", "application/json")
	w.Write(serialized)
}

// HTTP handler for retrieving a raw index of books.
func BookIndexHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Add("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte("<!DOCTYPE html><html><body>"))

	for bookId, entry := range index {
		w.Write([]byte(fmt.Sprintf("<a href='/#%s'>%s</a><br>", bookId, entry.Title)))
	}

	w.Write([]byte("</body></html>"))
}

func init() {
	var err error
	err = loadIndex()
	if err != nil {
		panic(err)
	}
}
