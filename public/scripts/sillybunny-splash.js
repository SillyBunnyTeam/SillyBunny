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
    var PLACEHOLDER_LINE = 'TODO(copy)';

    // English only: the splash renders before locales load. Lines never end in an ellipsis because
    // the animated dots are appended after them.
    var SPLASH_LINES = {
        reisen: [PLACEHOLDER_LINE],
        tewi: [PLACEHOLDER_LINE],
        both: [PLACEHOLDER_LINE],
    };

    // One horizontal strip per variant. The sheet URL is root-relative because a relative url() in a
    // custom property resolves against the stylesheet that reads it, not against the page. The service
    // worker caches /img/ by full URL, so change the key whenever a sheet or its metadata changes.
    var FRAMES = {
        reisen: { sheet: '/img/sillybunny/splash-reisen.png?v=20261029s', frames: 2, frameWidth: 128, frameHeight: 128, frameDurationMs: 400 },
        tewi: { sheet: '/img/sillybunny/splash-tewi.png?v=20261029s', frames: 2, frameWidth: 128, frameHeight: 128, frameDurationMs: 400 },
        both: { sheet: '/img/sillybunny/splash-both.png?v=20261029s', frames: 2, frameWidth: 192, frameHeight: 128, frameDurationMs: 400 },
    };

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

    function applyMascot(mascot, variant) {
        if (!mascot) return;
        var metadata = FRAMES[variant];
        mascot.setAttribute('data-variant', variant);
        mascot.style.setProperty('--sb-boot-sheet', 'url("' + metadata.sheet + '")');
        mascot.style.setProperty('--sb-boot-frames', String(metadata.frames));
        mascot.style.setProperty('--sb-boot-frame-w', metadata.frameWidth + 'px');
        mascot.style.setProperty('--sb-boot-frame-h', metadata.frameHeight + 'px');
        mascot.style.setProperty('--sb-boot-duration', metadata.frames * metadata.frameDurationMs + 'ms');
    }

    function applyLine(lineText, variant) {
        if (!lineText) return;
        var line = pickAtRandom(SPLASH_LINES[variant]);
        lineText.textContent = line;
        if (line !== PLACEHOLDER_LINE) {
            lineText.removeAttribute('data-sb-copy-placeholder');
            lineText.removeAttribute('data-sb-copy-slot');
            return;
        }
        lineText.setAttribute('data-sb-copy-placeholder', 'true');
        lineText.setAttribute('data-sb-copy-slot', 'SPLASH-' + variant.toUpperCase() + '-*');
    }

    function render(preloader) {
        if (!preloader) return;
        var variant = resolveVariant(readStorage(VARIANT_STORAGE_KEY));
        applyMascot(preloader.querySelector('.sb-boot-mascot'), variant);
        applyLine(preloader.querySelector('.sb-boot-line-text'), variant);
        // The Reduced Motion setting lives in settings that load after the splash paints, so the
        // last saved value is mirrored to localStorage for this script to read.
        if (readStorage(REDUCED_MOTION_STORAGE_KEY) === 'true') {
            preloader.classList.add('sb-boot-reduced');
        }
    }

    window.SillyBunnySplash = {
        SPLASH_LINES: SPLASH_LINES,
        FRAMES: FRAMES,
        resolveVariant: resolveVariant,
        render: render,
    };

    render(document.getElementById('preloader'));
})();
