export async function selectionCheckAppearance(check) {
    return check.evaluate(element => {
        const checkStyle = getComputedStyle(element);
        const glyphStyle = getComputedStyle(element, '::before');
        const borderWidth = parseFloat(checkStyle.borderTopWidth);
        const glyphWidth = parseFloat(glyphStyle.width);
        const glyphHeight = parseFloat(glyphStyle.height);
        const innerRadius = element.getBoundingClientRect().width / 2 - borderWidth;

        return {
            content: glyphStyle.content,
            glyphWidth,
            glyphHeight,
            backgroundImage: checkStyle.backgroundImage,
            display: checkStyle.display,
            placeContent: checkStyle.placeContent,
            centeredByGrid: checkStyle.display === 'grid' && checkStyle.placeContent === 'center',
            glyphFitsInnerCircle: Math.hypot(glyphWidth, glyphHeight) / 2 <= innerRadius,
        };
    });
}
