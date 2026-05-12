import {Composition} from 'remotion';
import {QuoteVideo} from './compositions/QuoteVideo';
import {defaultQuote2x1, defaultQuote1x1} from './data/defaultQuote';

const FPS = 50;
const DURATION_2X1_SECONDS = 7;
const DURATION_1X1_SECONDS = 6;

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="Quote2x1"
        component={QuoteVideo}
        durationInFrames={DURATION_2X1_SECONDS * FPS}
        fps={FPS}
        width={3840}
        height={1920}
        defaultProps={defaultQuote2x1}
      />
      <Composition
        id="Quote2x1Alpha"
        component={QuoteVideo}
        durationInFrames={DURATION_2X1_SECONDS * FPS}
        fps={FPS}
        width={3840}
        height={1920}
        defaultProps={{...defaultQuote2x1, transparent: true}}
      />
      <Composition
        id="Quote1x1"
        component={QuoteVideo}
        durationInFrames={DURATION_1X1_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1920}
        defaultProps={defaultQuote1x1}
      />
      <Composition
        id="Quote1x1Alpha"
        component={QuoteVideo}
        durationInFrames={DURATION_1X1_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1920}
        defaultProps={{...defaultQuote1x1, transparent: true}}
      />
    </>
  );
};
