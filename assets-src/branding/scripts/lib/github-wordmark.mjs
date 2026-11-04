/**
 * The wordmark "SillyBunny" as outlines, so the build needs no font at run time and every machine draws the same pixels.
 *
 * It is Adwaita Sans at its ExtraBold named instance (wght 800, opsz 14), shaped with HarfBuzz (kerning and the font's own
 * alternate "l" included), drawn y-down with the baseline at y = 0 and the pen at x = 0. Units are font units (2048 per em).
 * Adwaita Sans is licensed under the SIL Open Font License 1.1 (GNOME adwaita-fonts); outlines of it are not a font file.
 *
 * Made from the installed variable font with fontTools and HarfBuzz's hb-shape. Save the script below as a file and run
 *   python3 SCRIPT ~/.local/share/fonts/adwaita-sans-fonts/AdwaitaSans-Regular.ttf SillyBunny
 * and take "advance", "bounds" and "d" from its output:
 *
 *   import json, subprocess, sys
 *   from fontTools.ttLib import TTFont
 *   from fontTools.varLib.instancer import instantiateVariableFont
 *   from fontTools.pens.svgPathPen import SVGPathPen
 *   from fontTools.pens.transformPen import TransformPen
 *   from fontTools.pens.boundsPen import BoundsPen
 *
 *   FONT, TEXT = sys.argv[1], sys.argv[2]
 *   shaped = json.loads(subprocess.check_output(['hb-shape', f'--font-file={FONT}', '--variations=wght=800,opsz=14', '--output-format=json', TEXT]))
 *   font = instantiateVariableFont(TTFont(FONT), {'wght': 800, 'opsz': 14})
 *   glyphs = font.getGlyphSet()
 *   upem = font['head'].unitsPerEm
 *   pen = SVGPathPen(glyphs, ntos=lambda v: str(int(v)) if v == int(v) else ('%.1f' % v))
 *   bounds = BoundsPen(glyphs)
 *   x = 0
 *   for g in shaped:
 *       # y is flipped so the path is y-down with the baseline at 0
 *       for p in (pen, bounds):
 *           glyphs[g['g']].draw(TransformPen(p, (1, 0, 0, -1, x + g['dx'], -g['dy'])))
 *       x += g['ax']
 *   print(json.dumps({'upem': upem, 'advance': x, 'bounds': bounds.bounds, 'd': pen.getCommands()}))
 *
 * `test/github-wordmark.test.mjs` pins the numbers below, so a regenerated outline that differs fails a test.
 */
export const WORDMARK_TEXT = 'SillyBunny';
export const WORDMARK_UNITS_PER_EM = 2048;
export const WORDMARK_ADVANCE = 10944;
/** The ink box in font units, y-down: where the outline really starts and ends. */
export const WORDMARK_INK = Object.freeze({ left: 71.9, top: -1585.4, right: 10921.7, bottom: 426.0 });
export const WORDMARK_PATH = 'M691.2 19.9Q505.1 19.9 366.9 -36.3Q228.6 -92.4 151.7 -206.1Q74.8 -319.7 71.9 -491.8H410.6Q415.5 -420.0 450.5 -371.2Q485.4 -322.4 545.9 -297.8Q606.5 -273.2 686.6 -273.2Q760.3 -273.2 813.0 -293.3Q865.8 -313.4 894.2 -349.4Q922.6 -385.5 922.6 -432.6Q922.6 -475.7 896.5 -505.9Q870.4 -536.0 817.1 -559.0Q763.8 -581.9 681.5 -600.1L524.3 -636.6Q331.4 -680.8 221.1 -780.7Q110.9 -880.7 110.9 -1049.2Q110.9 -1187.4 185.7 -1291.0Q260.6 -1394.6 391.4 -1452.3Q522.2 -1510 691.3 -1510Q864.1 -1510 991.2 -1451.5Q1118.2 -1393.1 1188.3 -1288.4Q1258.4 -1183.7 1260.1 -1045.6H920.6Q913.6 -1127.2 854.9 -1172.3Q796.2 -1217.4 689.8 -1217.4Q619.7 -1217.4 571.9 -1198.8Q524.1 -1180.2 500.0 -1147.4Q476.0 -1114.5 476.0 -1072.6Q476.0 -1027.3 503.2 -995.8Q530.4 -964.2 580.2 -943.1Q630.0 -921.9 696.2 -906.9L824.6 -877.3Q932.5 -853.7 1017.2 -814.3Q1101.8 -774.9 1160.6 -720.0Q1219.4 -665.2 1249.7 -593.3Q1280.1 -521.4 1280.1 -431.8Q1280.1 -290.8 1209.7 -189.4Q1139.4 -88 1007.8 -34.0Q876.1 19.9 691.2 19.9ZM1467.4 0V-1118H1816.2V0ZM1641.3 -1248.6Q1566.7 -1248.6 1513.8 -1298.0Q1460.8 -1347.5 1460.8 -1416.8Q1460.8 -1487.5 1513.8 -1536.4Q1566.7 -1585.4 1641.3 -1585.4Q1715.9 -1585.4 1768.9 -1536.5Q1822.0 -1487.6 1822.0 -1416.8Q1822.0 -1347.4 1768.9 -1298.0Q1715.9 -1248.6 1641.3 -1248.6ZM2413.2 6.5Q2223.4 6.5 2135.4 -70.1Q2047.4 -146.8 2047.4 -307.3V-1490H2396.2V-347.0Q2396.2 -302.6 2415.0 -281.4Q2433.9 -260.2 2474.7 -260.2Q2496.9 -260.2 2509.2 -261.8Q2521.6 -263.4 2530.0 -266.6L2582.7 -20.4Q2558.7 -11.9 2515.0 -2.7Q2471.2 6.5 2413.2 6.5ZM3074.2 6.5Q2884.4 6.5 2796.4 -70.1Q2708.4 -146.8 2708.4 -307.3V-1490H3057.2V-347.0Q3057.2 -302.6 3076.0 -281.4Q3094.9 -260.2 3135.7 -260.2Q3157.9 -260.2 3170.2 -261.8Q3182.6 -263.4 3191.0 -266.6L3243.7 -20.4Q3219.7 -11.9 3176.0 -2.7Q3132.2 6.5 3074.2 6.5ZM3295.9 392.1 3373.8 137.3 3417.9 149.1Q3481.2 165.4 3528.5 158.1Q3575.8 150.9 3601.2 122.8Q3626.5 94.6 3623.9 48.8L3623.2 2.2L3206.1 -1118H3574.1L3741.4 -571.3Q3774.8 -458.9 3794.4 -345.9Q3813.9 -232.9 3840.6 -103.4H3769.3Q3796.0 -232.9 3822.9 -346.8Q3849.8 -460.7 3885.3 -571.3L4064.5 -1118H4427.7L3959.5 117.6Q3925.5 208.1 3870.0 277.8Q3814.5 347.4 3729.1 386.7Q3643.7 426 3517.6 426Q3453.6 426 3394.3 416.7Q3335.0 407.4 3295.9 392.1ZM4568.2 0V-1490H5185.8Q5352.5 -1490 5465.0 -1442.2Q5577.5 -1394.4 5634.2 -1309.5Q5691.0 -1224.5 5691.0 -1112.5Q5691.0 -1027.1 5655.4 -960.4Q5619.9 -893.8 5557.6 -850.3Q5495.2 -806.8 5413.5 -789.6V-774.1Q5503.3 -770.8 5579.6 -726.5Q5656.0 -682.1 5702.5 -603.0Q5749.0 -523.9 5749.0 -416.0Q5749.0 -296.4 5688.7 -202.2Q5628.5 -108.0 5513.2 -54.0Q5397.8 0 5232.5 0ZM4920.8 -285.0H5149.2Q5267.7 -285.0 5324.5 -330.8Q5381.3 -376.5 5381.3 -456.0Q5381.3 -514.3 5353.9 -557.1Q5326.6 -600 5276.1 -623.6Q5225.6 -647.1 5156.2 -647.1H4920.8ZM4920.8 -875.5H5125.7Q5185.2 -875.5 5231.5 -895.6Q5277.9 -915.7 5304.5 -953.5Q5331.1 -991.2 5331.1 -1044.6Q5331.1 -1119.6 5277.3 -1163.8Q5223.5 -1208.0 5131.7 -1208.0H4920.8ZM6315.8 14Q6199.0 14 6111.6 -38.2Q6024.2 -90.4 5976.3 -185.2Q5928.4 -279.9 5928.4 -406.5V-1118H6277.2V-473.9Q6277.2 -379.9 6325.4 -326.3Q6373.6 -272.6 6459.5 -272.6Q6516.7 -272.6 6559.3 -297.4Q6601.9 -322.1 6626.0 -368.7Q6650.0 -415.3 6650.0 -479.9V-1118H6999.0V0H6670.7L6664.6 -282.4H6679.5Q6638.2 -148.2 6550.3 -67.1Q6462.4 14 6315.8 14ZM7578.2 -638.1V0H7229.4V-1118H7557.5L7563.8 -835.6H7548.7Q7589.8 -969.3 7677.5 -1050.7Q7765.1 -1132 7912.6 -1132Q8030.2 -1132 8117.1 -1079.8Q8204.0 -1027.6 8251.9 -933.0Q8299.8 -838.3 8299.8 -711.5V0H7951.0V-644.1Q7951.0 -738.1 7902.9 -791.7Q7854.8 -845.4 7769.0 -845.4Q7712.5 -845.4 7669.4 -820.6Q7626.3 -795.9 7602.2 -749.8Q7578.2 -703.7 7578.2 -638.1ZM8879.2 -638.1V0H8530.4V-1118H8858.5L8864.8 -835.6H8849.7Q8890.8 -969.3 8978.5 -1050.7Q9066.1 -1132 9213.6 -1132Q9331.2 -1132 9418.1 -1079.8Q9505.0 -1027.6 9552.9 -933.0Q9600.8 -838.3 9600.8 -711.5V0H9252.0V-644.1Q9252.0 -738.1 9203.9 -791.7Q9155.8 -845.4 9070.0 -845.4Q9013.5 -845.4 8970.4 -820.6Q8927.3 -795.9 8903.2 -749.8Q8879.2 -703.7 8879.2 -638.1ZM9789.9 392.1 9867.8 137.3 9911.9 149.1Q9975.2 165.4 10022.5 158.1Q10069.8 150.9 10095.2 122.8Q10120.5 94.6 10117.9 48.8L10117.2 2.2L9700.1 -1118H10068.1L10235.4 -571.3Q10268.8 -458.9 10288.4 -345.9Q10307.9 -232.9 10334.6 -103.4H10263.3Q10290.0 -232.9 10316.9 -346.8Q10343.8 -460.7 10379.3 -571.3L10558.5 -1118H10921.7L10453.5 117.6Q10419.5 208.1 10364.0 277.8Q10308.5 347.4 10223.1 386.7Q10137.7 426 10011.6 426Q9947.6 426 9888.3 416.7Q9829.0 407.4 9789.9 392.1Z';
