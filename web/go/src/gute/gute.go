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
	"encoding/json"
	"strconv"
	"appengine/urlfetch"
	"appengine"
)

const (
	INDEX_NAME   = "index.gob"
	CHUNK_SIZE   = 0x10000
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

type BookInfo struct {
	ContentType string
	ChunkCount  int
}

type Book struct {
  BookInfo
	Raw  []byte
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
		book := &Book {
			BookInfo: BookInfo {
				ContentType: contentType,
				ChunkCount: len(raw) / CHUNK_SIZE,
			},
			Raw: raw,
		}

// Cache it locally.
// TODO: Decide where to store this. GCS?
//		outFile, err := os.OpenFile(relFile, os.O_CREATE|os.O_WRONLY, 0660)
//		if err != nil {
//			log.Printf("Error writing '%v': %v", relFile, err)
//			return nil, err
//		}
//		gob.NewEncoder(outFile).Encode(&book)
//		outFile.Close()

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
		w.Write(book.Raw[i * CHUNK_SIZE : (i + 1) * CHUNK_SIZE])
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

	serialized, err := json.Marshal(&book.BookInfo)

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
