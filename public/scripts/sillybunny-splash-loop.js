// The idle loops of the boot splash: each figure holds its frames on a timeline, blinks now and then, and the call, the
// strike and the sigh are drawn beside it. This is a classic script and not a module, like sillybunny-splash.js, which
// loads it only after the still has been painted, so the first paint never waits for it or for the frames. Keep it ES5
// in its syntax and free of imports. It reads the contract of the `<scene>--anim.json` files that the splash exporter
// writes. The blinks follow the same rules as sillybunny-home/art-motion.js, and tests/unit/sillybunny-splash-loop.test.js
// holds the two copies to the same results, because a classic script cannot import the other.
//
// Nothing here may leave the splash worse than the still: any failure, a smooth fit, Reduced Motion or a splash that is
// gone puts the still back or leaves it alone, and stops every timer.
(function () {
    'use strict';

    var DEFAULT_BLINK = {
        steps: [{ variant: 'half', ms: 70 }, { variant: 'closed', ms: 110 }, { variant: 'half', ms: 70 }],
        gapMs: [3600, 5400],
    };
    // The first blink of a figure is due 1.0 s plus a draw of up to 1.0 s in, and each figure 1.7 s later than the one
    // before. A figure waits until every other has had its eyes open for the clearance.
    var FIRST_BLINK_MS = 1000;
    var FIRST_BLINK_SPREAD_MS = 1000;
    var BLINK_STAGGER_MS = 1700;
    var BLINK_CLEARANCE_MS = 400;
    var BLINK_STEP_VARIANTS = ['half', 'closed'];
    var EFFECT_KINDS = ['rings', 'burst', 'puff'];
    // An effect is drawn again this often while it is on, as pixel art is drawn: in steps and not smoothly.
    var EFFECT_STEP_MS = 100;
    var REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var PLAIN_FILE_NAME = /^[\w@-][\w.@-]*$/;

    function isInteger(value) {
        return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
    }

    function requireInteger(value, what, min) {
        if (!isInteger(value) || value < min) {
            throw new Error(what + ' must be a whole number of at least ' + min + ', got ' + JSON.stringify(value) + '.');
        }
        return value;
    }

    function requireName(value, what) {
        if (typeof value !== 'string' || value === '') {
            throw new Error(what + ' must be a name, got ' + JSON.stringify(value) + '.');
        }
        return value;
    }

    // A plain name goes into a URL without any change, so a path, a query, a fragment, an escape or a name that starts with
    // a dot would reach something other than the picture that was meant.
    function requireFileName(value, what) {
        if (typeof value !== 'string' || !PLAIN_FILE_NAME.test(value)) {
            throw new Error(what + ' must be a plain file name of letters, digits and _ . @ -, not starting with a dot, got ' + JSON.stringify(value) + '.');
        }
        return value;
    }

    function has(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function parseTimeline(source, layer) {
        var where = 'The timeline of ' + layer.id;
        var seconds = source.seconds;
        if (!(typeof seconds === 'number' && seconds > 0 && isFinite(seconds))) {
            throw new Error(where + ' needs seconds above 0.');
        }
        if (!Array.isArray(source.keys) || source.keys.length === 0) {
            throw new Error(where + ' needs at least one key.');
        }
        var previous = -1;
        var keys = source.keys.map(function (key, index) {
            if (!(typeof key.at === 'number' && key.at >= 0 && key.at < seconds)) {
                throw new Error(where + ', key ' + index + ' must be at a time from 0 to below ' + seconds + ' seconds.');
            }
            if (index === 0 && key.at !== 0) {
                throw new Error(where + ' must start at 0, but its first key is at ' + key.at + '.');
            }
            if (key.at <= previous) {
                throw new Error(where + ' needs keys in strictly rising time, and key ' + index + ' is not.');
            }
            previous = key.at;
            if (!has(layer.frames, key.frame)) {
                throw new Error(where + ', key ' + index + ' shows the frame "' + key.frame + '", which the layer does not have.');
            }
            return { atMs: key.at * 1000, frame: key.frame };
        });
        var effects = (source.effects || []).map(function (effect, index) {
            if (EFFECT_KINDS.indexOf(effect.kind) === -1) {
                throw new Error(where + ', effect ' + index + ' is of the unknown kind ' + JSON.stringify(effect.kind) + '.');
            }
            if (!Array.isArray(effect.frames) || effect.frames.length === 0 || effect.frames.some(function (name) { return !has(layer.frames, name); })) {
                throw new Error(where + ', effect ' + index + ' needs frames that the layer has.');
            }
            if (!(typeof effect.from === 'number' && effect.from >= 0 && effect.from < seconds)) {
                throw new Error(where + ', effect ' + index + ' must start at a time from 0 to below ' + seconds + ' seconds.');
            }
            return {
                kind: effect.kind,
                frames: effect.frames.slice(),
                fromMs: effect.from * 1000,
                x: requireInteger(effect.x, where + ', effect ' + index + ' x', -100000),
                y: requireInteger(effect.y, where + ', effect ' + index + ' y', -100000),
            };
        });
        return { lengthMs: seconds * 1000, keys: keys, effects: effects };
    }

    function parseBlinks(blinks, layers) {
        if (blinks === undefined || blinks === null) {
            return { steps: DEFAULT_BLINK.steps, gapMs: DEFAULT_BLINK.gapMs, never: {} };
        }
        if (!Array.isArray(blinks.steps) || blinks.steps.length === 0) {
            throw new Error('The blinks of a scene need at least one step.');
        }
        if (!Array.isArray(blinks.gapMs) || blinks.gapMs.length !== 2) {
            throw new Error('The blinks of a scene need a shortest and a longest wait, gapMs: [min, max].');
        }
        var shortest = requireInteger(blinks.gapMs[0], 'gapMs[0]', 1);
        var longest = requireInteger(blinks.gapMs[1], 'gapMs[1]', 1);
        if (longest < shortest) {
            throw new Error('The longest wait between blinks (' + longest + ') is below the shortest (' + shortest + ').');
        }
        var never = {};
        var source = blinks.never || {};
        Object.keys(source).forEach(function (id) {
            var layer = layers.filter(function (candidate) { return candidate.id === id; })[0];
            if (!layer) {
                throw new Error('The blinks name the layer "' + id + '" in never, and the scene has none.');
            }
            if (!Array.isArray(source[id]) || source[id].some(function (name) { return !has(layer.frames, name); })) {
                throw new Error('The never frames of ' + id + ' must be frames of that layer.');
            }
            never[id] = source[id].slice();
        });
        return {
            steps: blinks.steps.map(function (step, index) {
                if (BLINK_STEP_VARIANTS.indexOf(step && step.variant) === -1) {
                    throw new Error('Blink step ' + index + ' shows the unknown kind ' + JSON.stringify(step && step.variant) + '.');
                }
                return { variant: step.variant, ms: requireInteger(step.ms, 'Blink step ' + index + ' ms', 1) };
            }),
            gapMs: [shortest, longest],
            never: never,
        };
    }

    // Reads `<scene>--anim.json` and halts on anything that is not what the exporter writes, so a bad file shows up as
    // one error here and the still stays. `art` is the size of the still that the loops move.
    function parseLoopScene(manifest, art) {
        if (!manifest || typeof manifest !== 'object') {
            throw new Error('A splash loop must be an object.');
        }
        var id = requireName(manifest.id, 'id');
        var width = requireInteger(manifest.grid && manifest.grid.width, id + ': grid width', 1);
        var height = requireInteger(manifest.grid && manifest.grid.height, id + ': grid height', 1);
        if (art && (width !== art.width || height !== art.height)) {
            throw new Error(id + ': the scene is ' + width + 'x' + height + ' art pixels but its still is ' + art.width + 'x' + art.height + '.');
        }
        if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
            throw new Error(id + ': a scene needs at least one layer.');
        }
        var layers = manifest.layers.map(function (layer, index) {
            var where = id + ', layer ' + index;
            var frames = {};
            if (!layer.frames || typeof layer.frames !== 'object') {
                throw new Error(where + ' has no frames.');
            }
            Object.keys(layer.frames).forEach(function (name) {
                frames[requireName(name, where + ' frame name')] = requireFileName(layer.frames[name], where + ', frame "' + name + '"');
            });
            if (!has(frames, layer.base)) {
                throw new Error(where + ' has the base frame "' + layer.base + '", which it does not have.');
            }
            return {
                id: requireName(layer.id, where + ' id'),
                z: requireInteger(layer.z, where + ' z', -100000),
                left: requireInteger(layer.left, where + ' left', 0),
                top: requireInteger(layer.top, where + ' top', 0),
                width: requireInteger(layer.width, where + ' width', 1),
                height: requireInteger(layer.height, where + ' height', 1),
                base: layer.base,
                frames: frames,
                order: index,
            };
        });
        layers.sort(function (a, b) { return a.z - b.z || a.order - b.order; });
        var timelines = {};
        var sources = manifest.timelines || {};
        Object.keys(sources).forEach(function (layerId) {
            var layer = layers.filter(function (candidate) { return candidate.id === layerId; })[0];
            if (!layer) {
                throw new Error(id + ': a timeline is for the layer "' + layerId + '", and the scene has none.');
            }
            timelines[layerId] = parseTimeline(sources[layerId], layer);
        });
        return { id: id, width: width, height: height, layers: layers, timelines: timelines, blinks: parseBlinks(manifest.blinks, layers) };
    }

    // The key that a timeline is at, `elapsedMs` into the scene: a key holds its frame until the next, the last holds
    // until the loop starts again, and there is no tweening.
    function keyAt(timeline, elapsedMs) {
        var inLoop = elapsedMs % timeline.lengthMs;
        var current = timeline.keys[0];
        for (var index = 0; index < timeline.keys.length; index++) {
            if (timeline.keys[index].atMs <= inLoop) current = timeline.keys[index];
        }
        return current;
    }

    function frameAt(layer, timeline, elapsedMs) {
        return timeline ? keyAt(timeline, elapsedMs).frame : layer.base;
    }

    // How long until the timeline changes its frame, at least 1 ms so a timer that fires early still moves on.
    function msUntilKeyChange(timeline, elapsedMs) {
        if (!timeline || timeline.keys.length < 2) return Infinity;
        var inLoop = elapsedMs % timeline.lengthMs;
        var next = timeline.lengthMs;
        for (var index = 0; index < timeline.keys.length; index++) {
            if (timeline.keys[index].atMs > inLoop) {
                next = timeline.keys[index].atMs;
                break;
            }
        }
        return Math.max(1, Math.ceil(next - inLoop));
    }

    function canBlink(layer) {
        return Object.keys(layer.frames).some(function (name) { return /-(half|closed)$/.test(name); });
    }

    // A blink shows `<frame>-<variant>`, and nothing changes for a frame that has no such picture.
    function pictureName(layer, frame, variant) {
        if (variant === 'base') return frame;
        return has(layer.frames, frame + '-' + variant) ? frame + '-' + variant : frame;
    }

    function blinkLengthMs(plan) {
        return plan.steps.reduce(function (sum, step) { return sum + step.ms; }, 0);
    }

    // A blink does not start if the timeline puts the layer in a frame that it must not blink in at any moment of the
    // blink's length.
    function blinkAllowed(scene, layer, startMs) {
        var never = scene.blinks.never[layer.id];
        if (!never || never.length === 0) return true;
        var timeline = scene.timelines[layer.id];
        var length = blinkLengthMs(scene.blinks);
        var seen = [frameAt(layer, timeline, startMs)];
        if (timeline) {
            var inLoop = startMs % timeline.lengthMs;
            for (var lap = 0; lap < 2; lap++) {
                for (var index = 0; index < timeline.keys.length; index++) {
                    var at = timeline.keys[index].atMs + lap * timeline.lengthMs;
                    if (at > inLoop && at < inLoop + length) seen.push(timeline.keys[index].frame);
                }
            }
        }
        return !seen.some(function (frame) { return never.indexOf(frame) !== -1; });
    }

    // The first blink of every figure that has pictures to blink with, and nothing for one that has none.
    function createBlinkState(scene, random) {
        return {
            layers: scene.layers.map(function (layer, index) {
                if (!canBlink(layer)) return null;
                return { dueMs: FIRST_BLINK_MS + index * BLINK_STAGGER_MS + random() * FIRST_BLINK_SPREAD_MS, startMs: null, endMs: -Infinity };
            }),
        };
    }

    // Where every figure is in its blinks at `elapsedMs`. A due blink starts only when no other figure is blinking, the
    // last blink of each other figure ended at least the clearance ago, and `allowed` says true; until then it waits and
    // its due time does not move. `allowed` may instead answer with the milliseconds until it is worth asking again,
    // so that a blink held back by the timeline is not asked for on every millisecond. The next blink is due a gap after
    // the start of this one.
    function stepBlinks(state, elapsedMs, plan, random, allowed) {
        var length = blinkLengthMs(plan);
        var shortest = plan.gapMs[0];
        var longest = plan.gapMs[1];
        var layers = state.layers.map(function (layer) { return layer ? { dueMs: layer.dueMs, startMs: layer.startMs, endMs: layer.endMs } : null; });
        layers.forEach(function (layer) {
            if (layer && layer.startMs !== null && elapsedMs >= layer.startMs + length) {
                layer.endMs = layer.startMs + length;
                layer.startMs = null;
            }
        });
        function clearAt(index) {
            var latest = -Infinity;
            layers.forEach(function (other, at) {
                if (at === index || !other) return;
                latest = Math.max(latest, (other.startMs === null ? other.endMs : other.startMs + length) + BLINK_CLEARANCE_MS);
            });
            return latest;
        }
        var retryMs = {};
        layers.forEach(function (layer, index) {
            if (!layer || layer.startMs !== null || elapsedMs < layer.dueMs || elapsedMs < clearAt(index)) return;
            var verdict = allowed(index, elapsedMs);
            if (verdict === true) {
                layer.startMs = elapsedMs;
                layer.dueMs = elapsedMs + shortest + Math.floor(random() * (longest - shortest + 1));
            } else {
                retryMs[index] = Math.max(1, verdict);
            }
        });
        var untilMs = Infinity;
        var variants = layers.map(function (layer, index) {
            if (!layer) return 'base';
            if (layer.startMs === null) {
                var startsAt = Math.max(layer.dueMs, clearAt(index));
                untilMs = Math.min(untilMs, has(retryMs, index) ? retryMs[index] : Math.max(1, Math.ceil(startsAt - elapsedMs)));
                return 'base';
            }
            var stepEnd = layer.startMs;
            for (var step = 0; step < plan.steps.length; step++) {
                stepEnd += plan.steps[step].ms;
                if (elapsedMs < stepEnd) {
                    untilMs = Math.min(untilMs, Math.ceil(stepEnd - elapsedMs));
                    return plan.steps[step].variant;
                }
            }
            throw new Error('A blink ended inside its own length.');
        });
        return { state: { layers: layers }, variants: variants, untilMs: untilMs };
    }

    // The pixels of a ring of radius `radius`, one art pixel thick, as rectangles of [x, y, width, height] around 0, 0.
    function ringRects(radius) {
        var rects = [];
        for (var dy = -radius; dy <= radius; dy++) {
            var row = Math.abs(dy);
            var outer = Math.round(Math.sqrt(radius * radius - row * row));
            var inner = row + 1 <= radius ? Math.round(Math.sqrt(radius * radius - (row + 1) * (row + 1))) : 0;
            rects.push([inner, dy, outer - inner + 1, 1]);
            if (inner > 0 || outer > 0) rects.push([-outer, dy, outer - inner + 1, 1]);
        }
        return rects;
    }

    // The shapes of an effect `ageMs` after it started, in art pixels from its origin. They are made of whole art pixels,
    // so they stay on the grid of the picture, and they are drawn in steps.
    function effectRects(kind, ageMs) {
        var rects = [];
        var index;
        var progress;
        if (kind === 'rings') {
            for (index = 0; index < 3; index++) {
                progress = (ageMs - 220 * index) / 700;
                if (progress >= 0 && progress < 1) rects = rects.concat(ringRects(3 + Math.floor(progress * 13)));
            }
        } else if (kind === 'burst') {
            if (ageMs >= 0 && ageMs < 450) {
                var distance = 3 + Math.floor((ageMs / 450) * 14);
                [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (direction) {
                    rects.push([direction[0] * distance - 1, direction[1] * distance - 1, 2, 2]);
                    if (distance >= 6) rects.push([direction[0] * (distance - 4), direction[1] * (distance - 4), 1, 1]);
                });
            }
        } else if (kind === 'puff') {
            for (index = 0; index < 3; index++) {
                progress = (ageMs - 250 * index) / 750;
                if (progress >= 0 && progress < 1) {
                    var size = progress > 0.6 ? 2 : 3;
                    rects.push([Math.floor(progress * 10) + index * 3, -Math.floor(progress * 14) - size, size, size]);
                }
            }
        }
        return rects;
    }

    function pathOf(rects) {
        return rects.map(function (rect) {
            return 'M' + rect[0] + ' ' + rect[1] + 'h' + rect[2] + 'v' + rect[3] + 'h' + (-rect[2]) + 'z';
        }).join('');
    }

    function now() {
        return window.performance && typeof window.performance.now === 'function' ? window.performance.now() : Date.now();
    }

    function readReducedMotion(preloader) {
        if (preloader.classList.contains('sb-boot-reduced')) return true;
        if (document.body && document.body.classList.contains('reduced-motion')) return true;
        return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
    }

    function splashOf(mascot) {
        var node = mascot.parentNode;
        while (node && !(node.classList && node.classList.contains('sb-boot-splash'))) node = node.parentNode;
        return node;
    }

    function createPicture(src) {
        var image = document.createElement('img');
        image.className = 'sb-boot-loop-layer';
        image.alt = '';
        image.decoding = 'async';
        image.draggable = false;
        image.style.visibility = 'hidden';
        image.src = src;
        return image;
    }

    function whenDecoded(image) {
        if (typeof image.decode === 'function') return image.decode();
        return new Promise(function (resolve, reject) {
            image.addEventListener('load', function () { resolve(); }, { once: true });
            image.addEventListener('error', function () { reject(new Error('The picture ' + image.src + ' did not load.')); }, { once: true });
        });
    }

    // An effect is drawn on a canvas of the whole scene and not of its layer, so a ring or a burst near the edge of the layer
    // is not cut off by it. The scene is the size of the still, and the box around it clips what leaves the picture.
    function createEffect(scene, layer, timeline, effect) {
        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'sb-boot-effect');
        svg.setAttribute('viewBox', '0 0 ' + scene.width + ' ' + scene.height);
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        var path = document.createElementNS(SVG_NS, 'path');
        svg.appendChild(path);
        return { layer: layer, timeline: timeline, kind: effect.kind, frames: effect.frames, fromMs: effect.fromMs, x: effect.x, y: effect.y, node: svg, path: path, drawn: '' };
    }

    // The pictures of a scene, decoded but not in the page: one node for each file of each layer, in drawing order, and
    // one for each effect.
    function buildRig(scene, urlOf) {
        var pending = [];
        var layers = scene.layers.map(function (layer) {
            var byFile = {};
            var pictures = {};
            var nodes = [];
            Object.keys(layer.frames).forEach(function (name) {
                var fileName = layer.frames[name];
                if (!byFile[fileName]) {
                    byFile[fileName] = createPicture(urlOf(fileName));
                    nodes.push(byFile[fileName]);
                    pending.push(byFile[fileName]);
                }
                pictures[name] = byFile[fileName];
            });
            return { layer: layer, pictures: pictures, nodes: nodes, shown: null, frame: layer.base };
        });
        var effects = [];
        scene.layers.forEach(function (layer) {
            var timeline = scene.timelines[layer.id];
            if (!timeline) return;
            timeline.effects.forEach(function (effect) { effects.push(createEffect(scene, layer, timeline, effect)); });
        });
        return Promise.all(pending.map(whenDecoded)).then(function () {
            return { scene: scene, layers: layers, effects: effects };
        });
    }

    // Plays the loop of the variant that `preloader` shows, once it can. Returns `{ stop, refresh }`, or null where the
    // splash has no loop to play or the page cannot play one.
    function start(preloader, options) {
        var settings = options || {};
        var splash = window.SillyBunnySplash;
        var mascot = preloader && preloader.querySelector('.sb-boot-mascot');
        if (!splash || !mascot) return null;
        var variant = mascot.getAttribute('data-variant');
        var file = splash.LOOP_FILES && splash.LOOP_FILES[variant];
        var art = splash.ART && splash.ART[variant];
        if (!file || !art) return null;
        if (typeof fetch !== 'function' || typeof Promise !== 'function' || typeof MutationObserver !== 'function') return null;
        var random = settings.random || Math.random;
        var clock = settings.now || now;
        var urlOf = function (fileName) { return '/img/sillybunny/' + fileName + '?v=' + splash.ART_VERSION; };

        var status = 'idle';
        var stopped = false;
        var playing = false;
        var startedAt = 0;
        var timer = 0;
        var rig = null;
        var blinkState = null;
        var wrapper = null;
        var observer = null;
        var query = null;

        // The boot guard can empty the preloader and leave it in the page, so the picture is what says that the splash is there.
        function isOnPage() {
            return preloader.isConnected && mascot.isConnected;
        }

        function readUnit() {
            var holder = splashOf(mascot);
            var unit = holder ? parseFloat(holder.style.getPropertyValue('--sb-boot-px')) : NaN;
            return unit > 0 ? unit : null;
        }

        // A fit that shrinks the still by a fraction has art pixels that are not whole device pixels, so layers on them
        // would show seams that the still does not have. A hidden document has nobody to see the loop.
        function canMove() {
            return !stopped && isOnPage() && !document.hidden && !readReducedMotion(preloader) && mascot.getAttribute('data-fit') !== 'smooth';
        }

        function setBox(node, layer, unit) {
            node.style.left = layer.left * unit + 'px';
            node.style.top = layer.top * unit + 'px';
            node.style.width = layer.width * unit + 'px';
            node.style.height = layer.height * unit + 'px';
        }

        // The layout of the splash sets the size of an art pixel again at every change of step, and the layers follow it.
        function place() {
            var unit = readUnit();
            if (!rig || unit === null) return;
            rig.layers.forEach(function (entry) {
                entry.nodes.forEach(function (node) { setBox(node, entry.layer, unit); });
            });
            rig.effects.forEach(function (effect) { setBox(effect.node, { left: 0, top: 0, width: rig.scene.width, height: rig.scene.height }, unit); });
        }

        function show(entry, frame, variant) {
            var picture = entry.pictures[pictureName(entry.layer, frame, variant)];
            entry.frame = frame;
            if (entry.shown === picture) return;
            if (entry.shown) entry.shown.style.visibility = 'hidden';
            picture.style.visibility = 'visible';
            entry.shown = picture;
        }

        // Draws the effects that are on, and returns how long until they have to be drawn again.
        function drawEffects(elapsedMs) {
            var wake = Infinity;
            rig.effects.forEach(function (effect) {
                var timeline = effect.timeline;
                var frame = frameAt(effect.layer, timeline, elapsedMs);
                var d = '';
                if (effect.frames.indexOf(frame) !== -1) {
                    var age = (((elapsedMs % timeline.lengthMs) - effect.fromMs) % timeline.lengthMs + timeline.lengthMs) % timeline.lengthMs;
                    d = pathOf(effectRects(effect.kind, age).map(function (rect) { return [rect[0] + effect.layer.left + effect.x, rect[1] + effect.layer.top + effect.y, rect[2], rect[3]]; }));
                    wake = Math.min(wake, EFFECT_STEP_MS - (age % EFFECT_STEP_MS));
                }
                if (effect.drawn !== d) {
                    effect.path.setAttribute('d', d);
                    effect.drawn = d;
                }
            });
            return wake;
        }

        // A frame that cannot be drawn ends the loop for good. Leaving the timer alone would freeze the last frame with the
        // still hidden under it.
        function tick() {
            try {
                drawFrame();
            } catch (error) {
                destroy();
                if (window.console && typeof window.console.warn === 'function') {
                    window.console.warn('The splash keeps its still: its loop stopped.', error);
                }
            }
        }

        function drawFrame() {
            // A splash that has gone, or that may no longer move, has nothing to play.
            if (!rig || !canMove()) {
                refresh();
                return;
            }
            var elapsedMs = clock() - startedAt;
            var scene = rig.scene;
            var blinks = stepBlinks(blinkState, elapsedMs, scene.blinks, random, function (index, startMs) {
                var layer = scene.layers[index];
                return blinkAllowed(scene, layer, startMs) || msUntilKeyChange(scene.timelines[layer.id], startMs);
            });
            blinkState = blinks.state;
            var wake = blinks.untilMs;
            rig.layers.forEach(function (entry, index) {
                var timeline = scene.timelines[entry.layer.id];
                show(entry, frameAt(entry.layer, timeline, elapsedMs), blinks.variants[index]);
                wake = Math.min(wake, msUntilKeyChange(timeline, elapsedMs));
            });
            wake = Math.min(wake, drawEffects(elapsedMs));
            if (wake !== Infinity) timer = window.setTimeout(tick, wake);
        }

        // The layers are hidden and the still shows. It is the same picture as the first frames, so there is no jump.
        function showStill() {
            if (rig) rig.nodes.forEach(function (node) { node.style.display = 'none'; });
            mascot.style.visibility = '';
        }

        function pause() {
            window.clearTimeout(timer);
            timer = 0;
            playing = false;
            showStill();
        }

        function play() {
            if (playing || !rig) return;
            playing = true;
            startedAt = clock();
            blinkState = createBlinkState(rig.scene, random);
            rig.nodes.forEach(function (node) { node.style.display = ''; });
            rig.layers.forEach(function (entry) {
                show(entry, frameAt(entry.layer, rig.scene.timelines[entry.layer.id], 0), 'base');
            });
            place();
            mascot.style.visibility = 'hidden';
            tick();
        }

        // The pictures go into a box that the still goes into as well, so the box has the size and the place of the still
        // at every step and nothing around it moves. Its overflow keeps the motion inside the picture.
        function install(built) {
            wrapper = document.createElement('span');
            wrapper.className = 'sb-boot-loop';
            wrapper.setAttribute('aria-hidden', 'true');
            mascot.parentNode.insertBefore(wrapper, mascot);
            wrapper.appendChild(mascot);
            var nodes = [];
            built.layers.forEach(function (entry) {
                entry.nodes.forEach(function (node) { nodes.push(node); });
            });
            built.effects.forEach(function (effect) { nodes.push(effect.node); });
            nodes.forEach(function (node) {
                node.style.display = 'none';
                wrapper.appendChild(node);
            });
            built.nodes = nodes;
            rig = built;
        }

        function load() {
            if (readUnit() === null) return;
            status = 'loading';
            window.fetch(urlOf(file)).then(function (response) {
                if (!response.ok) throw new Error(file + ': the server answered ' + response.status + '.');
                return response.json();
            }).then(function (manifest) {
                return buildRig(parseLoopScene(manifest, art), urlOf);
            }).then(function (built) {
                if (stopped) return;
                install(built);
                status = 'ready';
                refresh();
            }).catch(function (error) {
                if (stopped) return;
                // A loop that failed once would fail again, so the still stays.
                status = 'failed';
                destroy();
                if (window.console && typeof window.console.warn === 'function') {
                    window.console.warn('The splash keeps its still: its loop could not be loaded.', error);
                }
            });
        }

        function refresh() {
            if (stopped || status === 'failed') return;
            if (!isOnPage()) {
                destroy();
                return;
            }
            if (!canMove()) {
                pause();
                return;
            }
            if (status === 'idle') load();
            else if (status === 'ready') play();
        }

        // Ends it for good: no timer, no listener and no frame is kept, and the still shows.
        function destroy() {
            stopped = true;
            window.clearTimeout(timer);
            timer = 0;
            if (observer) observer.disconnect();
            observer = null;
            if (query && typeof query.removeEventListener === 'function') query.removeEventListener('change', refresh);
            query = null;
            window.removeEventListener('resize', place);
            document.removeEventListener('visibilitychange', refresh);
            if (rig) {
                rig.nodes.forEach(function (node) {
                    if (node.parentNode) node.parentNode.removeChild(node);
                });
            }
            rig = null;
            mascot.style.visibility = '';
        }

        // The body says that Reduced Motion came on or that the preloader was removed, the preloader says the same for
        // the saved setting and, when its children go, that the boot guard emptied it, and the still says that the layout gave it
        // a new size.
        observer = new MutationObserver(function () {
            refresh();
            place();
        });
        observer.observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
        observer.observe(preloader, { childList: true, attributes: true, attributeFilter: ['class'] });
        observer.observe(mascot, { attributes: true, attributeFilter: ['style', 'data-fit', 'data-step'] });
        window.addEventListener('resize', place);
        document.addEventListener('visibilitychange', refresh);
        if (typeof window.matchMedia === 'function') {
            query = window.matchMedia(REDUCED_MOTION_QUERY);
            if (typeof query.addEventListener === 'function') query.addEventListener('change', refresh);
        }
        refresh();
        return { stop: destroy, refresh: refresh };
    }

    window.SillyBunnySplashLoop = {
        DEFAULT_BLINK: DEFAULT_BLINK,
        FIRST_BLINK_MS: FIRST_BLINK_MS,
        FIRST_BLINK_SPREAD_MS: FIRST_BLINK_SPREAD_MS,
        BLINK_STAGGER_MS: BLINK_STAGGER_MS,
        BLINK_CLEARANCE_MS: BLINK_CLEARANCE_MS,
        parseLoopScene: parseLoopScene,
        frameAt: frameAt,
        msUntilKeyChange: msUntilKeyChange,
        canBlink: canBlink,
        pictureName: pictureName,
        blinkAllowed: blinkAllowed,
        createBlinkState: createBlinkState,
        stepBlinks: stepBlinks,
        effectRects: effectRects,
        start: start,
    };
}());
