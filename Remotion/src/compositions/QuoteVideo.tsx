import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {CSSProperties} from 'react';
import {colors, fontStack} from '../design/tokens';
import type {QuoteVideoProps} from '../types';

const clean = (value: string | undefined) => String(value ?? '').trim();

const wideQuoteMetrics = (text: string, scale: number) => {
  const length = text.length;
  if (length > 190) return {size: 112 * scale, line: 130 * scale};
  if (length > 130) return {size: 128 * scale, line: 146 * scale};
  if (length > 90) return {size: 145 * scale, line: 160 * scale};
  return {size: 156 * scale, line: 172 * scale};
};

const squareQuoteMetrics = (text: string, scale: number) => {
  const length = text.length;
  if (length > 190) return {size: 62 * scale, line: 84 * scale, width: 1360 * scale};
  if (length > 130) return {size: 70 * scale, line: 94 * scale, width: 1420 * scale};
  if (length > 90) return {size: 78 * scale, line: 104 * scale, width: 1500 * scale};
  return {size: 92 * scale, line: 118 * scale, width: 1480 * scale};
};

const FONT_CSS = `
@font-face {
  font-family: 'CoFo Sans';
  src: url('${staticFile('fonts/CoFo_Sans-Regular.ttf')}') format('truetype');
  font-weight: 400;
}
@font-face {
  font-family: 'CoFo Sans';
  src: url('${staticFile('fonts/CoFo_Sans-Medium.ttf')}') format('truetype');
  font-weight: 500 699;
}
@font-face {
  font-family: 'CoFo Sans';
  src: url('${staticFile('fonts/CoFo_Sans-Bold.ttf')}') format('truetype');
  font-weight: 700 849;
}
@font-face {
  font-family: 'CoFo Sans';
  src: url('${staticFile('fonts/CoFo_Sans-Black.ttf')}') format('truetype');
  font-weight: 850 950;
}
`;

const Background = ({
  transparent,
  image,
  blur = 0,
  dim = 0.62,
}: {
  transparent: boolean;
  image?: string;
  blur?: number;
  dim?: number;
}) => {
  if (transparent) return null;
  return (
    <AbsoluteFill style={{backgroundColor: colors.black}}>
      {image ? (
        <Img
          src={image}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: blur > 0 ? `blur(${blur}px)` : undefined,
            transform: blur > 0 ? 'scale(1.04)' : undefined,
          }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            background:
              [
                'radial-gradient(circle at 48% 0%, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0) 45%)',
                'repeating-linear-gradient(108deg, rgba(255,255,255,0.018) 0px, rgba(255,255,255,0.018) 1px, transparent 1px, transparent 9px)',
                'linear-gradient(135deg, rgb(45, 45, 49) 0%, rgb(18, 18, 21) 58%, rgb(5, 5, 7) 100%)',
              ].join(', '),
          }}
        />
      )}
      <AbsoluteFill style={{backgroundColor: `rgba(0, 0, 0, ${dim * 0.2})`}} />
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(0deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 25%, rgba(0,0,0,0.1) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};

const useAnimation = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: {damping: 20, stiffness: 95, mass: 0.9},
  });
  const delayed = spring({
    frame: Math.max(0, frame - 12),
    fps,
    config: {damping: 22, stiffness: 85, mass: 0.9},
  });
  const exit = interpolate(frame, [fps * 6.25, fps * 6.9], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return {enter, delayed, exit};
};

const WideQuote = ({
  quote,
  source,
  author,
  role,
  date,
  accent,
  transparent,
}: Required<Pick<QuoteVideoProps, 'quote' | 'source' | 'accent'>> &
  Pick<QuoteVideoProps, 'author' | 'role' | 'date' | 'transparent'>) => {
  const {width, height} = useVideoConfig();
  const {enter, delayed, exit} = useAnimation();
  const s = height / 1920;

  const left = 500 * s;
  const right = 3180 * s;
  const footerTop = 1356 * s;
  const quoteTop = 390 * s;
  const quoteWidth = 2905 * s;
  const {size: quoteSize, line: quoteLine} = wideQuoteMetrics(quote, s);
  const logoUtSize = 112 * s;
  const logoTextSize = 66 * s;
  const authorSize = 58 * s;
  const roleSize = 50 * s;
  const authorGap = 12 * s;
  const markOpacity = transparent ? 0.18 : 0.09;

  const shadow = transparent ? '0 8px 28px rgba(0,0,0,0.65)' : undefined;
  const authorLines = [clean(author), clean(role), clean(date)].filter(Boolean);

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: 290 * s,
          top: 188 * s,
          color: `rgba(255,255,255,${markOpacity})`,
          fontFamily: fontStack,
          fontSize: 560 * s,
          lineHeight: 0.78,
          fontWeight: 850,
          letterSpacing: 0,
          opacity: delayed * exit,
          transform: `translateY(${interpolate(delayed, [0, 1], [28 * s, 0])}px)`,
          textShadow: transparent ? '0 12px 44px rgba(0,0,0,0.5)' : undefined,
        }}
      >
        “
      </div>

      <div
        style={{
          position: 'absolute',
          left,
          top: quoteTop,
          width: quoteWidth,
          color: colors.white,
          fontFamily: fontStack,
          fontSize: quoteSize,
          lineHeight: `${quoteLine}px`,
          fontWeight: 500,
          letterSpacing: 0,
          textShadow: shadow,
          opacity: enter * exit,
          transform: `translateY(${interpolate(enter, [0, 1], [38 * s, 0])}px)`,
        }}
      >
        {quote}
      </div>

      <div
        style={{
          position: 'absolute',
          left,
          top: footerTop,
          color: colors.white,
          fontFamily: fontStack,
          display: 'flex',
          alignItems: 'baseline',
          gap: 36 * s,
          letterSpacing: 0,
          textShadow: shadow,
          opacity: delayed * exit,
          transform: `translateX(${interpolate(delayed, [0, 1], [-28 * s, 0])}px)`,
        }}
      >
        <span
          style={{
            fontSize: logoUtSize,
            lineHeight: `${logoUtSize}px`,
            fontWeight: 900,
          }}
        >
          UT
        </span>
        <span
          style={{
            fontSize: logoTextSize,
            lineHeight: `${logoTextSize}px`,
            fontWeight: 700,
          }}
        >
          {source.replace(/^UT\s*/i, '') || source}
        </span>
      </div>

      {authorLines.length > 0 && (
        <div
          style={{
            position: 'absolute',
            right: width - right,
            top: footerTop + 34 * s,
            color: colors.white,
            fontFamily: fontStack,
            textAlign: 'right',
            textShadow: shadow,
            opacity: delayed * exit,
            transform: `translateY(${interpolate(delayed, [0, 1], [24 * s, 0])}px)`,
          }}
        >
          {author && (
            <div
              style={{
                fontSize: authorSize,
                lineHeight: `${62 * s}px`,
                fontWeight: 650,
                letterSpacing: 0,
              }}
            >
              {author}
            </div>
          )}
          {role && (
            <div
              style={{
                marginTop: authorGap,
                color: 'rgb(173, 173, 173)',
                fontSize: roleSize,
                lineHeight: `${56 * s}px`,
                fontWeight: 400,
                letterSpacing: 0,
              }}
            >
              {role}
            </div>
          )}
          {!role && date && (
            <div
              style={{
                marginTop: authorGap,
                color: 'rgb(173, 173, 173)',
                fontSize: roleSize,
                lineHeight: `${56 * s}px`,
                fontWeight: 400,
                letterSpacing: 0,
              }}
            >
              {date}
            </div>
          )}
        </div>
      )}
    </>
  );
};

const SquareQuote = ({
  quote,
  source,
  author,
  role,
  date,
  accent,
  variant,
  transparent,
}: Required<Pick<QuoteVideoProps, 'quote' | 'source' | 'accent'>> &
  Pick<QuoteVideoProps, 'author' | 'role' | 'date' | 'variant' | 'transparent'>) => {
  const {width, height} = useVideoConfig();
  const {enter, delayed, exit} = useAnimation();
  const s = height / 1920;
  const safe = 178 * s;
  const {size: quoteSize, line: quoteLine, width: quoteWidth} = squareQuoteMetrics(quote, s);
  const left = Math.round((width - quoteWidth) / 2);
  const logoSize = 58 * s;
  const authorSize = 54 * s;
  const roleSize = 46 * s;
  const bottomSafe = height - safe;
  const shadow = transparent ? '0 8px 28px rgba(0,0,0,0.65)' : undefined;
  const markOpacity = transparent ? 0.18 : 0.09;

  const footerTop = bottomSafe - 92 * s;
  const quoteAreaTop = 625 * s;
  const quoteAreaHeight = 560 * s;

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: safe - 28 * s,
          top: 176 * s,
          color: `rgba(255,255,255,${markOpacity})`,
          fontFamily: fontStack,
          fontSize: 520 * s,
          lineHeight: 0.82,
          fontWeight: 850,
          letterSpacing: 0,
          opacity: delayed * exit,
          textShadow: transparent ? '0 12px 44px rgba(0,0,0,0.5)' : undefined,
        }}
      >
        “
      </div>

      <div
        style={{
          position: 'absolute',
          left,
          top: quoteAreaTop,
          width: quoteWidth,
          height: quoteAreaHeight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          color: colors.white,
          fontFamily: fontStack,
          fontSize: quoteSize,
          lineHeight: `${quoteLine}px`,
          fontWeight: 650,
          letterSpacing: 0,
          textAlign: 'left',
          textShadow: shadow,
          opacity: enter * exit,
          transform: `translateY(${interpolate(enter, [0, 1], [32 * s, 0])}px)`,
        }}
      >
        <div>
          {quote}
        </div>
      </div>

      {(source || author || role || date) && (
        <div
          style={{
            position: 'absolute',
            left,
            top: footerTop,
            width: quoteWidth,
            color: colors.white,
            fontFamily: fontStack,
            textShadow: shadow,
            opacity: delayed * exit,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 80 * s,
            }}
          >
            <div
              style={{
                minWidth: 0,
                fontSize: author ? authorSize : logoSize,
                lineHeight: `${72 * s}px`,
                fontWeight: 700,
                letterSpacing: 0,
              }}
            >
              {author || source}
            </div>
            <div
              style={{
                color: 'rgb(173, 173, 173)',
                fontSize: roleSize,
                lineHeight: `${72 * s}px`,
                fontWeight: 400,
                letterSpacing: 0,
                textAlign: 'right',
                whiteSpace: 'nowrap',
              }}
            >
              {date}
            </div>
          </div>
          {role && (
            <div
              style={{
                marginTop: 8 * s,
                color: 'rgb(173, 173, 173)',
                fontSize: roleSize,
                lineHeight: `${62 * s}px`,
                fontWeight: 400,
              }}
            >
              {role}
            </div>
          )}
        </div>
      )}
    </>
  );
};

export const QuoteVideo = ({
  transparent = false,
  variant = 'editorial',
  source = 'UT',
  quote,
  author,
  role,
  date,
  accent = colors.amber,
  background,
}: QuoteVideoProps) => {
  const {width, height} = useVideoConfig();
  const isWide = width / height > 1.4;
  const rootStyle: CSSProperties = {
    overflow: 'hidden',
    backgroundColor: transparent ? 'transparent' : colors.black,
    fontFamily: fontStack,
  };

  return (
    <AbsoluteFill style={rootStyle}>
      <style>{FONT_CSS}</style>
      <Background
        transparent={transparent}
        image={background?.image}
        blur={background?.blur}
        dim={background?.dim}
      />
      {isWide ? (
        <WideQuote
          quote={quote}
          source={clean(source) || 'UT'}
          author={author}
          role={role}
          date={date}
          accent={accent}
          transparent={transparent}
        />
      ) : (
        <SquareQuote
          quote={quote}
          source={clean(source) || 'UT'}
          author={author}
          role={role}
          date={date}
          accent={accent}
          variant={variant}
          transparent={transparent}
        />
      )}
    </AbsoluteFill>
  );
};
