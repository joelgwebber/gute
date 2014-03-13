package app

import (
	"net/http"
	"gute"
)

func init() {
	http.HandleFunc("/index", gute.BookIndexHandler)
	http.HandleFunc("/book", gute.BookHandler)
	http.HandleFunc("/page", gute.PageHandler)
}
