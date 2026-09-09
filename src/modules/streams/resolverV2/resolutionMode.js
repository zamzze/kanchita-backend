'use strict';

const selectResolutionMode = ({ primaryEnabled = false, shadowEnabled = false } = {}) => {
  if (typeof primaryEnabled !== 'boolean' || typeof shadowEnabled !== 'boolean') {
    throw new Error('RESOLUTION_MODE_INVALID_INPUT');
  }
  if (primaryEnabled) return 'primary';
  return shadowEnabled ? 'shadow' : 'legacy';
};

module.exports = { selectResolutionMode };
