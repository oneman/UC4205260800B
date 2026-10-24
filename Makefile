CC      ?= cc
CFLAGS  ?= -O2 -Wall -Wextra -std=c11 -D_POSIX_C_SOURCE=200809L
LDLIBS  = -lz
BUILD   = build

all: $(BUILD)/uc

$(BUILD)/uc: src/uc_cli.c src/uc.c src/uc.h | $(BUILD)
	$(CC) $(CFLAGS) -o $@ src/uc_cli.c src/uc.c $(LDLIBS)

$(BUILD)/test_uc: src/test_uc.c src/uc.c src/uc.h | $(BUILD)
	$(CC) $(CFLAGS) -o $@ src/test_uc.c src/uc.c $(LDLIBS)

$(BUILD):
	mkdir -p $(BUILD)

demo: $(BUILD)/uc
	python3 script/make_demo.py htdocs/demo.zip

test: $(BUILD)/uc $(BUILD)/test_uc
	$(BUILD)/test_uc
	$(BUILD)/uc facts
	python3 -m unittest discover -s script -p 'test_*.py'
	node --test htdocs/test/*.test.mjs

clean:
	rm -rf $(BUILD)

.PHONY: all demo test clean
