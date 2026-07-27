import React from 'react';
import { LOGO_PATH_TRANSFORM, LOGO_VIEWBOX, OPENSHIP_LOGO_PATH } from './logo-path';

interface LogoProps {
  className?: string;
  color?: string;
}

/** The Openship wordmark glyph. Path data lives in ./logo-path so illustrations
 *  that embed the mark share this exact geometry instead of copying it. */
const Logo: React.FC<LogoProps> = ({ className = '', color = '#fff' }) => {
  return (
    <svg
      className={className}
      style={{ width: 60, height: 50 }}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${LOGO_VIEWBOX.width} ${LOGO_VIEWBOX.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <g transform={LOGO_PATH_TRANSFORM} fill={color} stroke="none">
        <path d={OPENSHIP_LOGO_PATH} />
      </g>
    </svg>
  );
};

export default Logo;
