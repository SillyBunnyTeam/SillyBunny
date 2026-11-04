// Classic script, not a module: it must run synchronously right after the preloader markup so the
// first paint already shows the chosen mascot. Keep it ES5 and free of imports for the same reason.
(function () {
    'use strict';

    // The first of the boot marks; the others are listed in sillybunny-boot-marks.js. Old browsers have no marks.
    if (window.performance && typeof window.performance.mark === 'function') {
        window.performance.mark('sb-boot-inline');
    }

    var VARIANT_STORAGE_KEY = 'sb-splash-character';
    var REDUCED_MOTION_STORAGE_KEY = 'sb-reduced-motion';
    var VARIANTS = ['reisen', 'tewi', 'both'];

    // English only: the splash renders before locales load. One pool for every character, one line picked per load.
    // Lines never end in an ellipsis because the animated dots are appended after them.
    var SPLASH_LINES = [
        'Girls are writing stories',
        'Girls are playing roles',
        'Girls are conversing',
        'Girls are preparing',
    ];

    // The line is typed out one letter at a time, then the dots come in one by one. The CSS reads these three times
    // from custom properties, so the delay of the dots can follow the length of the line.
    var REVEAL_START_MS = 300;
    var LETTER_MS = 45;
    var DOTS_PAUSE_MS = 200;

    // Each picture is stored at its own size in art pixels, so the table is what lets the script size the box before
    // the file has loaded. tests/unit/sillybunny-splash.test.js reads the files and the export spec and fails when a
    // size is stale. The URL is root-relative and the service worker caches /img/ by full URL, so change the key
    // whenever a file changes.
    var ART_VERSION = '20261104b';
    var ART = {
        reisen: { file: 'splash-reisen@native.webp', width: 204, height: 366 },
        tewi: { file: 'splash-tewi@native.webp', width: 141, height: 320 },
        both: { file: 'splash-both@native.webp', width: 263, height: 366 },
    };

    // All three pictures are sized by the tallest of them, so one screen has one step and Tewi keeps her height
    // relative to Reisen whichever character the splash shows.
    var TALLEST_ROWS = Math.max(ART.reisen.height, ART.tewi.height, ART.both.height);
    // The tallest picture may be at most this share of the viewport height. The step is the largest whole number of
    // device pixels per art pixel that stays within it: a fraction of a device pixel is drawn unevenly.
    var HEIGHT_SHARE = 0.42;
    // A screen that cannot hold step 1 within HEIGHT_SHARE may still show step 1 up to this share. Past it, step 1 would
    // take the room of the line under the picture, and the picture is shrunk to HEIGHT_SHARE by a fraction instead.
    var STEP_ONE_MAX_SHARE = 0.6;
    // Room for the rounding of a division that lands exactly on a whole step.
    var EPSILON = 1e-6;

    function readStorage(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (_error) {
            // Storage can be blocked; fall back to the defaults.
            return null;
        }
    }

    function pickAtRandom(items) {
        return items[Math.floor(Math.random() * items.length)];
    }

    function resolveVariant(storedValue) {
        if (VARIANTS.indexOf(storedValue) !== -1) return storedValue;
        return pickAtRandom(VARIANTS);
    }

    function readRatio() {
        var ratio = window.devicePixelRatio;
        return ratio > 0 && isFinite(ratio) ? ratio : 1;
    }

    // How the pictures are drawn on a viewport `viewportHeight` CSS pixels tall: a whole step, or a fraction of one.
    // `cssPerArtPixel` is the CSS size of one art pixel, which the width and the height of every picture follow.
    function chooseFit(viewportHeight, ratio) {
        var stepOne = { step: 1, smooth: false, cssPerArtPixel: 1 / ratio };
        // Without a viewport height the shares below mean nothing, so the picture keeps one whole step.
        if (!(viewportHeight > 0)) return stepOne;
        var fitting = Math.floor((HEIGHT_SHARE * viewportHeight * ratio) / TALLEST_ROWS + EPSILON);
        if (fitting >= 1) return { step: fitting, smooth: false, cssPerArtPixel: fitting / ratio };
        if (TALLEST_ROWS / ratio <= STEP_ONE_MAX_SHARE * viewportHeight + EPSILON) return stepOne;
        return { step: 0, smooth: true, cssPerArtPixel: (HEIGHT_SHARE * viewportHeight) / TALLEST_ROWS };
    }

    function sizeMascot(mascot, variant) {
        var art = ART[variant];
        var fit = chooseFit(window.innerHeight, readRatio());
        mascot.style.width = art.width * fit.cssPerArtPixel + 'px';
        mascot.style.height = art.height * fit.cssPerArtPixel + 'px';
        // The sparkles beside the line are drawn on the grid of the mascot, so they take its size of an art pixel.
        if (mascot.parentNode) mascot.parentNode.style.setProperty('--sb-boot-px', fit.cssPerArtPixel + 'px');
        // loader.css turns off the pixelated rendering of a picture that is drawn at a fraction of a step.
        mascot.setAttribute('data-fit', fit.smooth ? 'smooth' : 'step');
        if (fit.smooth) {
            mascot.removeAttribute('data-step');
            return;
        }
        mascot.setAttribute('data-step', String(fit.step));
    }

    // A zoom changes the width of the window, and a move to another screen changes only the ratio. A resolution query
    // names one ratio and fires once when it stops matching, so it is made again after each change.
    function watchSize(mascot, variant) {
        function isAttached() {
            return document.documentElement.contains(mascot);
        }
        function update() {
            if (!isAttached()) {
                window.removeEventListener('resize', update);
                return;
            }
            sizeMascot(mascot, variant);
        }
        function watchRatio() {
            if (typeof window.matchMedia !== 'function') return;
            var query = window.matchMedia('(resolution: ' + readRatio() + 'dppx)');
            var onChange = function () {
                update();
                // A query that is made again for a splash that is gone would keep the removed markup alive.
                if (isAttached()) watchRatio();
            };
            if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange, { once: true });
        }
        window.addEventListener('resize', update);
        watchRatio();
    }

    function applyMascot(mascot, variant) {
        if (!mascot) return;
        var art = ART[variant];
        mascot.setAttribute('data-variant', variant);
        mascot.setAttribute('width', String(art.width));
        mascot.setAttribute('height', String(art.height));
        // The box has its size before the file is requested, so the line under it does not move when the file arrives.
        sizeMascot(mascot, variant);
        mascot.src = '/img/sillybunny/' + art.file + '?v=' + ART_VERSION;
        watchSize(mascot, variant);
    }

    // Every letter is its own element so that CSS can give it a turn. A space stays a text node, so the line still
    // breaks between words and never inside one.
    // Returns how many letters the reveal has to type, which sets when the dots start.
    function applyLine(lineText, line) {
        if (!lineText) return 0;
        lineText.textContent = '';
        var typed = 0;
        for (var index = 0; index < line.length; index++) {
            var character = line.charAt(index);
            if (character === ' ') {
                lineText.appendChild(document.createTextNode(' '));
                continue;
            }
            var letter = document.createElement('span');
            letter.className = 'sb-boot-letter';
            letter.style.setProperty('--n', String(typed));
            letter.textContent = character;
            lineText.appendChild(letter);
            typed++;
        }
        return typed;
    }

    function render(preloader) {
        if (!preloader) return;
        var variant = resolveVariant(readStorage(VARIANT_STORAGE_KEY));
        applyMascot(preloader.querySelector('.sb-boot-mascot'), variant);
        var line = pickAtRandom(SPLASH_LINES);
        var typed = applyLine(preloader.querySelector('.sb-boot-line-text'), line);
        // The letters are hidden from assistive technology, since a reader may take each one as a separate item, and
        // the line is given to it whole here.
        var reader = preloader.querySelector('.sb-boot-line-reader');
        if (reader) reader.textContent = line;
        preloader.style.setProperty('--sb-boot-reveal-start', REVEAL_START_MS + 'ms');
        preloader.style.setProperty('--sb-boot-letter-step', LETTER_MS + 'ms');
        preloader.style.setProperty('--sb-boot-dots-start', REVEAL_START_MS + typed * LETTER_MS + DOTS_PAUSE_MS + 'ms');
        // The Reduced Motion setting lives in settings that load after the splash paints, so the
        // last saved value is mirrored to localStorage for this script to read.
        if (readStorage(REDUCED_MOTION_STORAGE_KEY) === 'true') {
            preloader.classList.add('sb-boot-reduced');
        }
    }

    window.SillyBunnySplash = {
        SPLASH_LINES: SPLASH_LINES,
        ART: ART,
        ART_VERSION: ART_VERSION,
        HEIGHT_SHARE: HEIGHT_SHARE,
        STEP_ONE_MAX_SHARE: STEP_ONE_MAX_SHARE,
        TALLEST_ROWS: TALLEST_ROWS,
        chooseFit: chooseFit,
        resolveVariant: resolveVariant,
        render: render,
    };

    render(document.getElementById('preloader'));
})();
