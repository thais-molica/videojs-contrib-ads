/**
 * Basic Ad support plugin for video.js.
 *
 * Common code to support ad integrations.
 */
(function(window, document, vjs, undefined) {
"use strict";

var

  /**
   * Copies properties from one or more objects onto an original.
   */
  extend = function(obj /*, arg1, arg2, ... */) {
    var arg, i, k;
    for (i=1; i<arguments.length; i++) {
      arg = arguments[i];
      for (k in arg) {
        if (arg.hasOwnProperty(k)) {
          obj[k] = arg[k];
        }
      }
    }
    return obj;
  },

  /**
   * Add a handler for multiple listeners to an object that supports addEventListener() or on().
   *
   * @param {object} obj The object to which the handler will be assigned.
   * @param {mixed} events A string, array of strings, or hash of string/callback pairs.
   * @param {function} callback Invoked when specified events occur, if events param is not a hash.
   *
   * @return {object} obj The object passed in.
   */
  on = function(obj, events, handler) {

    var

      type = Object.prototype.toString.call(events),

      register = function(obj, event, handler) {
        if (obj.addEventListener) {
          obj.addEventListener(event, handler);
        } else if (obj.on) {
          obj.on(event, handler);
        } else if (obj.attachEvent) {
          obj.attachEvent('on' + event, handler);
        } else {
          throw new Error('object has no mechanism for adding event listeners');
        }
      },

      i,
      ii;

    switch (type) {
      case '[object String]':
        register(obj, events, handler);
        break;
      case '[object Array]':
        for (i = 0, ii = events.length; i<ii; i++) {
          register(obj, events[i], handler);
        }
        break;
      case '[object Object]':
        for (i in events) {
          if (events.hasOwnProperty(i)) {
            register(obj, i, events[i]);
          }
        }
        break;
      default:
        throw new Error('Unrecognized events parameter type: ' + type);
    }

    return obj;

  },

  /**
   * Runs the callback at the next available opportunity.
   * @see https://developer.mozilla.org/en-US/docs/Web/API/window.setImmediate
   */
  setImmediate = function(callback) {
    return (
      window.setImmediate ||
      window.requestAnimationFrame ||
      window.mozRequestAnimationFrame ||
      window.webkitRequestAnimationFrame ||
      window.setTimeout
    )(callback, 0);
  },

  /**
   * Clears a callback previously registered with `setImmediate`.
   * @param {id} id The identifier of the callback to abort
   */
  clearImmediate = function(id) {
    return (window.clearImmediate ||
            window.cancelAnimationFrame ||
            window.webkitCancelAnimationFrame ||
            window.mozCancelAnimationFrame ||
            window.clearTimeout)(id);
  },

  /**
   * If ads are not playing, pauses the player at the next available
   * opportunity. Has no effect if ads have started. This function is necessary
   * because pausing a video element while processing a `play` event on iOS can
   * cause the video element to continuously toggle between playing and paused
   * states.
   *
   * @param {object} player The video player
   */
  cancelContentPlay = function(player) {
    if (player.ads.cancelPlayTimeout) {
      // another cancellation is already in flight, so do nothing
      return;
    }
    player.ads.cancelPlayTimeout = setImmediate(function() {
      // deregister the cancel timeout so subsequent cancels are scheduled
      player.ads.cancelPlayTimeout = null;

      // pause playback so ads can be handled.
      if (!player.paused()) {
        player.pause();
      }

      // add a contentplayback handler to resume playback when ads finish.
      player.one('contentplayback', function() {
        if (player.paused()) {
          player.play();
        }
      });
    });
  },

  /**
   * Returns an object that captures the portions of player state relevant to
   * video playback. The result of this function can be passed to
   * restorePlayerSnapshot with a player to return the player to the state it
   * was in when this function was invoked.
   * @param {object} player The videojs player object
   */
  getPlayerSnapshot = function(player) {
    var
      tech = player.el().querySelector('.vjs-tech'),
      tracks = player.remoteTextTracks ? player.remoteTextTracks() : [],
      track,
      i,
      suppressedTracks = [],
      snapshot = {
        ended: player.ended(),
        src: player.currentSrc(),
        currentTime: player.currentTime(),
        type: player.currentType()
      };

    if (tech) {
      snapshot.nativePoster = tech.poster;
      snapshot.style = tech.getAttribute('style');
    }

    i = tracks.length;
    while (i--) {
      track = tracks[i];
      suppressedTracks.push({
        track: track,
        mode: track.mode
      });
      track.mode = 'disabled';
    }
    snapshot.suppressedTracks = suppressedTracks;

    return snapshot;
  },

  removeClass = function(element, className) {
    var
      classes = element.className.split(/\s+/),
      i = classes.length,
      newClasses = [];
    while (i--) {
      if (classes[i] !== className) {
        newClasses.push(classes[i]);
      }
    }
    element.className = newClasses.join(' ');
  },

  /**
   * Attempts to modify the specified player so that its state is equivalent to
   * the state of the snapshot.
   * @param {object} snapshot - the player state to apply
   */
  restorePlayerSnapshot = function(player, snapshot) {
    var
      // the playback tech
      tech = player.el().querySelector('.vjs-tech'),

      // the number of remaining attempts to restore the snapshot
      attempts = 20,

      suppressedTracks = snapshot.suppressedTracks,
      trackSnapshot,
      restoreTracks =  function() {
        var i = suppressedTracks.length;
        while (i--) {
          trackSnapshot = suppressedTracks[i];
          trackSnapshot.track.mode = trackSnapshot.mode;
        }
      },

      // finish restoring the playback state
      resume = function() {
        var
          ended = false,
          updateEnded = function() {
            ended = true;
          };
        player.currentTime(snapshot.currentTime);

        // Resume playback if this wasn't a postroll
        if (!snapshot.ended) {
          player.play();
        } else {
          // On iOS 8.1, the "ended" event will not fire if you seek
          // directly to the end of a video. To make that behavior
          // consistent with the standard, fire a synthetic event if
          // "ended" does not fire within 250ms. Note that the ended
          // event should occur whether the browser actually has data
          // available for that position
          // (https://html.spec.whatwg.org/multipage/embedded-content.html#seeking),
          // so it should not be necessary to wait for the seek to
          // indicate completion.
          window.setTimeout(function() {
            if (!ended) {
              player.play();
            }
            player.off('ended', updateEnded);
          }, 250);
          player.on('ended', updateEnded);
        }
      },

      // determine if the video element has loaded enough of the snapshot source
      // to be ready to apply the rest of the state
      tryToResume = function() {
        if (tech.seekable === undefined) {
          // if the tech doesn't expose the seekable time ranges, try to
          // resume playback immediately
          resume();
          return;
        }
        if (tech.seekable.length > 0) {
          // if some period of the video is seekable, resume playback
          resume();
          return;
        }

        // delay a bit and then check again unless we're out of attempts
        if (attempts--) {
          setTimeout(tryToResume, 50);
        } else {
          videojs.log.warn('Failed to resume the content after an advertisement');
        }
      },

      // whether the video element has been modified since the
      // snapshot was taken
      srcChanged;

    if (snapshot.nativePoster) {
      tech.poster = snapshot.nativePoster;
    }

    if ('style' in snapshot) {
      // overwrite all css style properties to restore state precisely
      tech.setAttribute('style', snapshot.style || '');
    }

    // Determine whether the player needs to be restored to its state
    // before ad playback began. With a custom ad display or burned-in
    // ads, the content player state hasn't been modified and so no
    // restoration is required

    if (player.src()) {
      // the player was in src attribute mode before the ad and the
      // src attribute has not been modified, no restoration is required
      // to resume playback
      srcChanged = player.src() !== snapshot.src;
    } else {
      // the player was configured through source element children
      // and the currentSrc hasn't changed, no restoration is required
      // to resume playback
      srcChanged = player.currentSrc() !== snapshot.src;
    }

    if (srcChanged) {
      // on ios7, fiddling with textTracks too early will cause safari to crash
      player.one('contentloadedmetadata', restoreTracks);

      // if the src changed for ad playback, reset it
      player.src({ src: snapshot.src, type: snapshot.type });
      // safari requires a call to `load` to pick up a changed source
      player.load();
      // and then resume from the snapshots time once the original src has loaded
      player.one('contentloadedmetadata', tryToResume);
    } else if (!player.ended() || !snapshot.ended) {
      // if we didn't change the src, just restore the tracks
      restoreTracks();

      // the src didn't change and this wasn't a postroll
      // just resume playback at the current time.
      player.play();
    }
  },

  /**
   * Remove the poster attribute from the video element tech, if present. When
   * reusing a video element for multiple videos, the poster image will briefly
   * reappear while the new source loads. Removing the attribute ahead of time
   * prevents the poster from showing up between videos.
   * @param {object} player The videojs player object
   */
  removeNativePoster = function(player) {
    var tech = player.el().querySelector('.vjs-tech');
    if (tech) {
      tech.removeAttribute('poster');
    }
  },

  // ---------------------------------------------------------------------------
  // Ad Framework
  // ---------------------------------------------------------------------------

  // default framework settings
  defaults = {
    // maximum amount of time in ms to wait to receive `adsready` from the ad
    // implementation after play has been requested. Ad implementations are
    // expected to load any dynamic libraries and make any requests to determine
    // ad policies for a video during this time.
    timeout: 5000,

    // maximum amount of time in ms to wait for the ad implementation to start
    // linear ad mode after `readyforpreroll` has fired. This is in addition to
    // the standard timeout.
    prerollTimeout: 100,

    // maximum amount of time in ms to wait for the ad implementation to start
    // linear ad mode after `contentended` has fired.
    postrollTimeout: 100,

    // when truthy, instructs the plugin to output additional information about
    // plugin state to the video.js log. On most devices, the video.js log is
    // the same as the developer console.
    debug: false
  },

  adFramework = function(options) {
    var
      player = this,

      // merge options and defaults
      settings = extend({}, defaults, options || {}),

      fsmHandler;

    // prefix all video element events during ad playback
    // if the video element emits ad-related events directly,
    // plugins that aren't ad-aware will break. prefixing allows
    // plugins that wish to handle ad events to do so while
    // avoiding the complexity for common usage
    (function() {
      var
        videoEvents = videojs.Html5.Events,
        i = videoEvents.length,
        triggerEvent = function(type, event) {
          event.stopImmediatePropagation();
          player.trigger({
            type: type + event.type,
            state: player.ads.state,
            originalEvent: event
          });
        },
        redispatch = function(event) {
          if (player.ads.state === 'ad-playback') {
            triggerEvent('ad', event);

          } else if (player.ads.state === 'content-playback' && event.type === 'ended') {
            triggerEvent('content', event);

          } else if (player.ads.state === 'content-resuming') {
            if (player.ads.snapshot) {
              if (player.currentSrc() !== player.ads.snapshot.src) {
                if (event.type === 'loadstart') {
                  return;
                }
                return triggerEvent('content', event);

              } else if (player.ads.snapshot.ended) {
                if ((event.type === 'pause' ||
                    event.type === 'ended')) {
                  player.addClass('vjs-has-started');
                  return;
                }
                return triggerEvent('content', event);
              }
            }
            if (event.type !== 'playing') {
              triggerEvent('content', event);
            }
          }
        };

      while (i--) {
        player.on(videoEvents[i], redispatch);
      }
      return redispatch;
    })();

    // replace the ad initializer with the ad namespace
    player.ads = {
      state: 'content-set',

      startLinearAdMode: function() {
        player.trigger('adstart');
      },

      endLinearAdMode: function() {
        player.trigger('adend');
      }
    };

    fsmHandler = function(event) {
      // Ad Playback State Machine
      var
        fsm = {
          'content-set': {
            events: {
              'adscanceled': function() {
                this.state = 'content-playback';
              },
              'adsready': function() {
                this.state = 'ads-ready';
              },
              'play': function() {
                this.state = 'ads-ready?';
                cancelContentPlay(player);
                // remove the poster so it doesn't flash between videos
                removeNativePoster(player);
              },
              'adserror': function() {
                this.state = 'content-playback';
              }
            }
          },
          'ads-ready': {
            events: {
              'play': function() {
                this.state = 'preroll?';
                cancelContentPlay(player);
              },
              'adserror': function() {
                this.state = 'content-playback';
              }
            }
          },
          'preroll?': {
            enter: function() {
              // change class to show that we're waiting on ads
              player.el().className += ' vjs-ad-loading';
              // schedule an adtimeout event to fire if we waited too long
              player.ads.timeout = window.setTimeout(function() {
                player.trigger('adtimeout');
              }, settings.prerollTimeout);
              // signal to ad plugin that it's their opportunity to play a preroll
              player.trigger('readyforpreroll');
            },
            leave: function() {
              window.clearTimeout(player.ads.timeout);
              removeClass(player.el(), 'vjs-ad-loading');
            },
            events: {
              'play': function() {
                cancelContentPlay(player);
              },
              'adstart': function() {
                this.state = 'ad-playback';
                player.el().className += ' vjs-ad-playing';
              },
              'adtimeout': function() {
                this.state = 'content-playback';
              },
              'adserror': function() {
                this.state = 'content-playback';
              }
            }
          },
          'ads-ready?': {
            enter: function() {
              player.el().className += ' vjs-ad-loading';
              player.ads.timeout = window.setTimeout(function() {
                player.trigger('adtimeout');
              }, settings.timeout);
            },
            leave: function() {
              window.clearTimeout(player.ads.timeout);
              removeClass(player.el(), 'vjs-ad-loading');
            },
            events: {
              'play': function() {
                cancelContentPlay(player);
              },
              'adscanceled': function() {
                this.state = 'content-playback';
              },
              'adsready': function() {
                this.state = 'preroll?';
              },
              'adtimeout': function() {
                this.state = 'content-playback';
              },
              'adserror': function() {
                this.state = 'content-playback';
              }
            }
          },
          'ad-playback': {
            enter: function() {
              // capture current player state snapshot (playing, currentTime, src)
              this.snapshot = getPlayerSnapshot(player);

              // remove the poster so it doesn't flash between videos
              removeNativePoster(player);
              // We no longer need to supress play events once an ad is playing.
              // Clear it if we were.
              if (player.ads.cancelPlayTimeout) {
                clearImmediate(player.ads.cancelPlayTimeout);
                player.ads.cancelPlayTimeout = null;
              }
            },
            leave: function() {
              removeClass(player.el(), 'vjs-ad-playing');

              restorePlayerSnapshot(player, this.snapshot);
              if (player.ads.triggerevent !== 'adend') {
                // trigger 'adend' as a consistent notification
                // event that we're exiting ad-playback.
                player.trigger('adend');
              }
            },
            events: {
              'adend': function() {
                this.state = 'content-resuming';
              },
              'adserror': function() {
                this.state = 'content-resuming';
              }
            }
          },
          'content-resuming': {
            events: {
              'contentupdate': function() {
                this.state = 'content-set';
              },
              'playing': function() {
                this.state = 'content-playback';
              },
              'ended': function() {
                this.state = 'content-playback';
              }
            }
          },
          'postroll?': {
            enter: function() {
              this.snapshot = getPlayerSnapshot(player);

              player.el().className += ' vjs-ad-loading';

              player.ads.timeout = window.setTimeout(function() {
                player.trigger('adtimeout');
              }, settings.postrollTimeout);
            },
            leave: function() {
              window.clearTimeout(player.ads.timeout);
              removeClass(player.el(), 'vjs-ad-loading');
            },
            events: {
              'adstart': function() {
                this.state = 'ad-playback';
                player.el().className += ' vjs-ad-playing';
              },
              'adtimeout': function() {
                this.state = 'content-resuming';
                setImmediate(function() {
                  player.trigger('ended');
                });
              },
              'adserror': function() {
                this.state = 'content-resuming';
                setImmediate(function() {
                  player.trigger('ended');
                });
              }
            }
          },
          'content-playback': {
            enter: function() {
              // make sure that any cancelPlayTimeout is cleared
              if (player.ads.cancelPlayTimeout) {
                clearImmediate(player.ads.cancelPlayTimeout);
                player.ads.cancelPlayTimeout = null;
              }
              // this will cause content to start if a user initiated
              // 'play' event was canceled earlier.
              player.trigger({
                type: 'contentplayback',
                triggerevent: player.ads.triggerevent
              });
            },
            events: {
              // in the case of a timeout, adsready might come in late.
              'adsready': function() {
                player.trigger('readyforpreroll');
              },
              'adstart': function() {
                this.state = 'ad-playback';
                player.el().className += ' vjs-ad-playing';
                // remove the poster so it doesn't flash between videos
                removeNativePoster(player);
              },
              'contentupdate': function() {
                if (player.paused()) {
                  this.state = 'content-set';
                } else {
                  this.state = 'ads-ready?';
                }
              },
              'contentended': function() {
                this.state = 'postroll?';
              }
            }
          }
        };

      (function(state) {
        var noop = function() {};

        // process the current event with a noop default handler
        ((fsm[state].events || {})[event.type] || noop).apply(player.ads);

        // check whether the state has changed
        if (state !== player.ads.state) {

          // record the event that caused the state transition
          player.ads.triggerevent = event.type;

          // execute leave/enter callbacks if present
          (fsm[state].leave || noop).apply(player.ads);
          (fsm[player.ads.state].enter || noop).apply(player.ads);

          // output debug logging
          if (settings.debug) {
            videojs.log('ads', player.ads.triggerevent + ' triggered: ' + state + ' -> ' + player.ads.state);
          }
        }

      })(player.ads.state);

    };

    // register for the events we're interested in
    on(player, vjs.Html5.Events.concat([
      // events emitted by ad plugin
      'adtimeout',
      'contentupdate',
      'contentplaying',
      'contentended',

      // events emitted by third party ad implementors
      'adsready',
      'adserror',
      'adscanceled',
      'adstart',  // startLinearAdMode()
      'adend'     // endLinearAdMode()
    ]), fsmHandler);

    // keep track of the current content source
    // if you want to change the src of the video without triggering
    // the ad workflow to restart, you can update this variable before
    // modifying the player's source
    player.ads.contentSrc = player.currentSrc();

    // implement 'contentupdate' event.
    (function(){
      var
        // check if a new src has been set, if so, trigger contentupdate
        checkSrc = function() {
          var src;
          if (player.ads.state !== 'ad-playback') {
            src = player.currentSrc();
            if (src !== player.ads.contentSrc) {
              player.trigger({
                type: 'contentupdate',
                oldValue: player.ads.contentSrc,
                newValue: src
              });
              player.ads.contentSrc = src;
            }
          }
        };
      // loadstart reliably indicates a new src has been set
      player.on(['loadstart'], checkSrc);
      // check immediately in case we missed the loadstart
      setImmediate(checkSrc);
    })();

    // kick off the fsm
    if (!player.paused()) {
      // simulate a play event if we're autoplaying
      fsmHandler({type:'play'});
    }

  };

  // register the ad plugin framework
  vjs.plugin('ads', adFramework);

})(window, document, videojs);
