/*
 * See the NOTICE file distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation; either version 2.1 of
 * the License, or (at your option) any later version.
 *
 * This software is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this software; if not, write to the Free
 * Software Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
 * 02110-1301 USA, or see the FSF site: http://www.fsf.org.
 */
define([
  'RTFrontend_realtime_input',
  'RTFrontend_errorbox',
  'jquery',
  'RTFrontend_crypto',
  'json.sortify',
  'xwiki-meta'
], /* jshint maxparams:false */ function(realtimeInput, ErrorBox, $, Crypto, stringify, xwikiMeta) {
  'use strict';

  var warn = function(x) {
    console.log(x);
  }, debug = function(x) {
    console.log(x);
  }, verbose = function(x) {};

  var SAVE_DOC_TIME = 60000,
    // how often to check if the document has been saved recently
    SAVE_DOC_CHECK_CYCLE = 20000;

  var now = function() {
    return new Date().getTime();
  };

  var Saver = {};

  var mainConfig = Saver.mainConfig = {};

  // Contains the realtime data
  var rtData = {};

  var lastSaved = window.lastSaved = Saver.lastSaved = {
    content: '',
    time: 0,
    // http://jira.xwiki.org/browse/RTWIKI-37
    hasModifications: false,
    // for future tracking of 'edited since last save'
    // only show the merge dialog to those who have edited
    wasEditedLocally: false,
    receivedISAVE: false,
    shouldRedirect: false,
    isavedSignature: '',
    mergeMessage: function() {}
  },

  configure = Saver.configure = function(config) {
    $.extend(mainConfig, {
      ajaxMergeUrl: config.ajaxMergeUrl + '?xpage=plain&outputSyntax=plain',
      ajaxVersionUrl: config.ajaxVersionUrl,
      language: config.language,
      messages: config.messages,
      version: config.version,
      chainpad: config.chainpad,
      editorType: config.editorType,
      isHTML: config.isHTML,
      mergeContent: config.mergeContent,
      editorName: config.editorName,
      safeCrash: function(reason) {
        warn(reason);
      },
      safeSave: config.safeSave
    });
    $.extend(lastSaved, {
      version: config.version,
      time: config.versionTime
    });
  },

  updateLastSaved = Saver.update = function(content) {
    $.extend(lastSaved, {
      time: now(),
      content: content,
      wasEditedLocally: false
    });
  },

  isaveInterrupt = Saver.interrupt = function() {
    if (lastSaved.receivedISAVE) {
      warn("Another client sent an ISAVED message.");
      warn("Aborting save action");
      // unset the flag, or else it will persist
      lastSaved.receivedISAVE = false;
      // return true such that calling functions know to abort
      return true;
    }
    return false;
  },

  /**
   * Retrieves attributes about the local document for the purposes of ajax merge (just data-xwiki-document and
   * lastSaved.version).
   */
  getDocumentStatistics = function() {
    var $html = $('html'),
      fields = [
        // 'space', 'page',
        'wiki',
        'document' // includes space and page
      ],
      result = {};

    // We can't rely on people pushing the new lastSaved.version. If they quit before ISAVED other clients won't get the
    // new version. This isn't such an issue, because they _will_ converge eventually.
    result.version = lastSaved.version;

    fields.forEach(function (field) {
      result[field] = $html.data('xwiki-'+field);
    });

    result.language = mainConfig.language;

    return result;
  },

  ajaxMerge = function(content, cb) {
    var url = mainConfig.ajaxMergeUrl;

    // version, document
    var stats = getDocumentStatistics();

    stats.content = content;
    if (mainConfig.isHTML) {
      stats.convertHTML = 1;
    }

    verbose("Posting with the following stats");
    verbose(stats);

    $.ajax({
      url: url,
      method: 'POST',
      dataType: 'json',
      success: function (data) {
        try {
          // data is already an "application/json"
          var merge = data;
          var error = merge.conflicts &&
            merge.conflicts.length &&
            merge.conflicts[0].formattedMessage;
          if (error) {
            merge.error=error;
            cb(error, merge);
          } else {
            // let the callback handle textarea writes
            cb(null,merge);
          }
        } catch (err) {
          var debugLog = {
            state: 'ajaxMerge/parseError',
            lastSavedVersion: lastSaved.version,
            lastSavedContent: lastSaved.content,
            cUser: mainConfig.userName,
            mergeData: data,
            error: err
          };
          ErrorBox.show('parse', JSON.stringify(debugLog));
          warn(err);
          cb(err, data);
        }
      },
      data: stats,
      error: function (err) {
        var debugLog = {
          state: 'ajaxMerger/velocityError',
          lastSavedVersion: lastSaved.version,
          lastSavedContent: lastSaved.content,
          cContent: content,
          cUser: mainConfig.userName,
          err: err
        };
        ErrorBox.show('velocity', JSON.stringify(debugLog));
        warn(err);
      },
    });
  },

  // Check a server-side api for the version string of the document.
  ajaxVersion = function(cb) {
    var url = mainConfig.ajaxVersionUrl + '?xpage=plain';
    var stats = getDocumentStatistics();
    $.ajax({
      url: url,
      method: 'POST',
      dataType: 'json',
      success: function(data) {
        cb(null, data);
      },
      data: stats,
      error: function(err) {
        cb(err, null);
      }
    });
  },

  bumpVersion = function(callback, versionData) {
    var callbackWrapper = function(error, out) {
      if (error) {
        var debugLog = {
          state: 'bumpVersion',
          lastSavedVersion: lastSaved.version,
          lastSavedContent: lastSaved.content,
          cUser: mainConfig.userName,
          cContent: mainConfig.getTextValue()
        };
        mainConfig.safeCrash('updateversion', JSON.stringify(debugLog));
        warn(error);
      } else if (out) {
        debug('Triggering lastSaved refresh on remote clients');
        lastSaved.version = out.version;
        lastSaved.content = out.content;
        /* jshint camelcase:false */
        var contentHash = (mainConfig.chainpad && mainConfig.chainpad.hex_sha256 &&
          mainConfig.chainpad.hex_sha256(out.content)) || '';
        saveMessage(lastSaved.version, contentHash);
        if (typeof callback === 'function') {
          callback(out);
        }
      } else {
        throw new Error();
      }
    };
    if (versionData) {
      callbackWrapper(null, versionData);
    } else {
      ajaxVersion(callbackWrapper);
    }
  },

  getFormToken = Saver.getFormToken = function() {
    return $('meta[name="form_token"]').attr('content');
  },


  // http://jira.xwiki.org/browse/RTWIKI-29
  saveDocument = function(data, andThen) {
    /* RT_event-on_save */

    var defaultData = {
      // title if can be done realtime
      xredirect: '',
      xeditaction: 'edit',
      // TODO make this translatable
      comment: 'Auto-Saved by Realtime Session',
      'action_saveandcontinue': 'Save & Continue',
      minorEdit: 1,
      ajax: true,
      'form_token': getFormToken(),
      language: mainConfig.language
    };

    // Remove from the data the properties we want to override.
    data.split('&').filter(function(arg) {
      var name = (arg.split('=').length > 1) ? arg.split('=')[0] : arg;      
      return Object.keys(defaultData).indexOf(name) < 0;
    }).join('&');
    data += '&' + Object.toQueryString(defaultData);

    $.ajax({
      url: window.docsaveurl,
      type: "POST",
      async: true,
      dataType: 'text',

      // http://jira.xwiki.org/browse/RTWIKI-36
      // Don't worry about hijacking and resuming. If you can just add the usual fields to this, simply steal the event.
      data: data,
      success: function() {
        andThen();
      },
      error: function(jqxhr, err, cause) {
        var debugLog = {
          state: 'saveDocument',
          lastSavedVersion: lastSaved.version,
          lastSavedContent: lastSaved.content,
          cUser: mainConfig.userName,
          cContent: mainConfig.getTextValue(),
          err: err
        };
        ErrorBox.show('save', JSON.stringify(debugLog));
        warn(err);
        // Don't callback, this way in case of error we will keep trying.
      }
    });
  },

  ISAVED = 1,
  // sends an ISAVED message
  saveMessage = function(version, hash) {
    var newState = {
      version: version,
      by: mainConfig.userName,
      hash: hash,
      editorName: mainConfig.editorName
    };
    rtData[mainConfig.editorType] = newState;
    mainConfig.onLocal();

    mainConfig.chainpad.onSettle(function() {
      if (typeof lastSaved.onReceiveOwnIsave === 'function') {
        lastSaved.onReceiveOwnIsave();
      }
    });
  },

  presentMergeDialog = function(question, labelDefault, choiceDefault, labelAlternative, choiceAlternative) {
    var behave = {
      onYes: choiceDefault,
      onNo: choiceAlternative
    };

    var param = {
      confirmationText: question,
      yesButtonText: labelDefault,
      noButtonText: labelAlternative,
      showCancelButton: true
    };

    new XWiki.widgets.ConfirmationBox(behave, param);
  },

  destroyDialog = Saver.destroyDialog = function(callback) {
    var $box = $('.xdialog-box.xdialog-box-confirmation'),
      $content = $box.find('.xdialog-content');
    if ($box.length) {
      $content.find('.button.cancel').click();
    }
    if (typeof callback === 'function') {
      callback(!!$box.length);
    }
  },

  // Only used within 'createSaver'.
  redirectToView = function() {
    window.location.href = window.XWiki.currentDocument.getURL('view');
  },

  // Have rtwiki call this on local edits.
  setLocalEditFlag = Saver.setLocalEditFlag = function(condition) {
    lastSaved.wasEditedLocally = condition;
  },

  resolveMergeConflicts = function(merge) {
    // There was a merge conflict we'll need to resolve.
    warn(merge.error);

    // Halt the autosave cycle to give the user time. Don't halt forever though, because you might disconnect and hang.
    mergeDialogCurrentlyDisplayed = true;

    var deferred = $.Deferred();
    presentMergeDialog(
      /* jshint camelcase:false */
      mainConfig.messages.mergeDialog_prompt,

      /* jshint camelcase:false */
      mainConfig.messages.mergeDialog_keepRealtime,

      function() {
        debug("User chose to use the realtime version!");
        // unset the merge dialog flag
        mergeDialogCurrentlyDisplayed = false;
        deferred.resolve();
      },

      /* jshint camelcase:false */
      mainConfig.messages.mergeDialog_keepRemote,

      function() {
        debug("User chose to use the remote version!");
        // unset the merge dialog flag
        mergeDialogCurrentlyDisplayed = false;
        var restURL = XWiki.currentDocument.getRestURL();
        if (mainConfig.language !== 'default' && !/\/pages\/(.+)\/translations\//.test(restURL)) {
          restURL = restURL + mainConfig.language;
        }

        $.ajax({
          url: restURL + '?media=json',
          method: 'GET',
          dataType: 'json',
          success: function (data) {
            mainConfig.setTextValue(data.content, true, function() {
              debug("Overwrote the realtime session's content with the latest saved state");
              bumpVersion(function () {
                lastSaved.mergeMessage('merge overwrite', []);
              }, null);
              deferred.resolve();
            });
          },
          error: function (error) {
            mainConfig.safeCrash('keepremote');
            warn("Encountered an error while fetching remote content");
            warn(error);
            deferred.reject();
          }
        });
      }
    );
    return deferred.promise();
  },

  mergedWithoutConflicts = function(merge, preMergeContent) {
    var deferred = $.Deferred();
    // The content was merged and there were no errors / conflicts.
    if (preMergeContent !== mainConfig.getTextValue()) {
      // There have been changes since merging. Don't overwrite if there have been changes while merging
      // See http://jira.xwiki.org/browse/RTWIKI-37
      // Try again in one cycle.
      deferred.reject();
    } else {
      // Walk the tree of hashes and if merge.previousVersionContent exists, then this merge is quite possibly faulty.
      if (mainConfig.realtime.getDepthOfState(merge.previousVersionContent) !== -1) {
        debug("The server merged a version which already existed in the history. " +
          "Reversions shouldn't merge. Ignoring merge.");
        debug("waseverstate=true");
        deferred.resolve();
      } else {
        debug("The latest version content does not exist anywhere in our history.");
        debug("Continuing...");
        // There were no errors or local changes. Push to the textarea.
        mainConfig.setTextValue(merge.content, false, function() {
          deferred.resolve();
        });
      }
    }
    return deferred.promise();
  },

  // callback takes signature (error, shouldSave)
  mergeContinuation = function(merge, callback) {
    // Our continuation has three cases:
    if (isaveInterrupt()) {
      // 1. ISAVE interrupt error
      callback('ISAVED interrupt', null);
    } else if (merge.saveRequired) {
      // 2. saveRequired
      callback(null, true);
    } else {
      // 3. saveNotRequired
      callback(null, false);
    }
  },

  mergeCallback = function(preMergeContent, andThen, error, merge) {
    if (error) {
      if (!merge || typeof merge === 'undefined') {
        warn('The ajax merge API did not return an object. Something went wrong');
        warn(error);
        return;
      } else if (error === merge.error) {
        // There was a merge error. Continue and handle elsewhere.
        warn(error);
      } else {
        // It was some other kind of error... parsing? Complain and return. This means the script failed.
        warn(error);
        return;
      }
    }

    if (isaveInterrupt()) {
      andThen('ISAVED interrupt', null);

    } else if (merge.content === lastSaved.content) {
      // Don't dead end, but indicate that you shouldn't save.
      andThen("Merging didn't result in a change.", false);
      setLocalEditFlag(false);

    // http://jira.xwiki.org/browse/RTWIKI-34
    // Give Messages when merging
    } else if (merge.merged) {
      // TODO update version field with merge.currentVersion
      console.log("Force updating version to: " + merge.currentVersion);
      if (xwikiMeta.setVersion) {
        xwikiMeta.setVersion(merge.currentVersion);
      }
      // A merge took place.
      if (merge.error) {
        resolveMergeConflicts(merge).done($.proxy(mergeContinuation, null, merge, andThen));
      } else {
        mergedWithoutConflicts(merge, preMergeContent).done(function() {
          mergeContinuation(merge, andThen);
        }).fail(function() {
          andThen("The realtime content changed while we were performing our asynchronous merge.", false);
        });
      }

    } else {
      // No merge was necessary, but you might still have to save.
      mergeContinuation(merge, andThen);
    }
  },

  mergeRoutine = function(andThen) {
    // post your current version to the server to see if it must merge
    // remember the current state so you can check if it has changed.
    var preMergeContent = mainConfig.getTextValue();
    ajaxMerge(preMergeContent, $.proxy(mergeCallback, null, preMergeContent, andThen));
  },

  onMessage = function(data) {
    // set a flag so any concurrent processes know to abort
    lastSaved.receivedISAVE = true;

    /* RT_event-on_isave_receive

      clients update lastSaved.version when they perform a save,
      then they send an ISAVED with the version
      a single user might have multiple windows open, for some reason
      but might still have different save cycles
      checking whether the received version matches the local version
      tells us whether the ISAVED was set by our *browser*
      if not, we should treat it as foreign.
    */

    var newSave = function(type, msg) {
      var msgSender = msg.by;
      var msgVersion = msg.version;
      var msgHash = msg.hash;
      var msgEditor = type;
      var msgEditorName = msg.editorName;

      var displaySaverName = function(isMerged) {
        // a merge dialog might be open, if so, remove it and say as much
        destroyDialog(function(dialogDestroyed) {
          if (dialogDestroyed) {
            // tell the user about the merge resolution
            lastSaved.mergeMessage('conflictResolved', [msgVersion]);
          } else if (!mainConfig.initializing) {
            var sender;
            // otherwise say there was a remote save
            // http://jira.xwiki.org/browse/RTWIKI-34
            if (mainConfig.userList) {
              sender = msgSender.replace(/^.*-([^-]*)%2d[0-9]*$/, function(all, one) {
                return decodeURIComponent(one);
              });
            }
            if (isMerged) {
              lastSaved.mergeMessage('savedRemote', [msgVersion, sender]);
            } else {
              lastSaved.mergeMessage('savedRemoteNoMerge', [msgVersion, sender, msgEditorName]);
            }
          }
        });
      };

      if (msgEditor === mainConfig.editorType) {
        if (lastSaved.version !== msgVersion) {
          displaySaverName(true);

          if (!mainConfig.initializing) {
            debug('A remote client saved and incremented the latest common ancestor');
          }

          // update lastSaved attributes
          lastSaved.wasEditedLocally = false;

          // update the local latest Common Ancestor version string
          lastSaved.version = msgVersion;

          // remember the state of the textArea when last saved
          // so that we can avoid additional minor versions
          // there's a *tiny* race condition here
          // but it's probably not an issue
          lastSaved.content = mainConfig.getTextValue();
        } else if (typeof lastSaved.onReceiveOwnIsave === 'function') {
          lastSaved.onReceiveOwnIsave();
        }
        lastSaved.time = now();
      } else {
        displaySaverName(false);
      }
    };

    // If the channel data is empty, do nothing (initial call in onReady)
    if (Object.keys(data).length === 0) {
      return;
    }
    for (var editor in data) {
      if (typeof data[editor] !== "object" || Object.keys(data[editor]).length !== 4) {
        continue;
      } // corrupted data
      if (rtData[editor] && stringify(rtData[editor]) === stringify(data[editor])) {
        continue;
      } // no change
      newSave(editor, data[editor]);
      if (xwikiMeta.refreshVersion) {
        xwikiMeta.refreshVersion();
      }
    }
    rtData = data;

    return false;
  },

  /**
   * createSaver contains some of the more complicated logic in this script. Clients check for remote changes on random
   * intervals. If another client has saved outside of the realtime session, changes are merged on the server using
   * XWiki's threeway merge algo. The changes are integrated into the local textarea, which replicates across realtime
   * sessions. If the resulting state does not match the last saved content, then the contents are saved as a new
   * version. Other members of the session are notified of the save, and the resulting new version. They then update
   * their local state to match. During this process, a series of checks are made to reduce the number of unnecessary
   * saves, as well as the number of unnecessary merges.
   */
  mergeDialogCurrentlyDisplayed = false,
  createSaver = Saver.create = function(config) {
    $.extend(mainConfig, {
      getTextValue: config.getTextValue || null,
      getSaveValue: config.getSaveValue || null,
      setTextValue: config.setTextValue || null,
      formId: config.formId || "edit",
      userList: config.userList,
      userName: config.userName,
      realtime: config.realtime
    });
    var netfluxNetwork = config.network;
    var channel = config.channel;
    var demoMode = config.demoMode;
    var firstConnection = true;

    if (typeof config.safeCrash === 'function') {
      mainConfig.safeCrash = config.safeCrash;
    }

    lastSaved.time = now();

    var onOpen = function(chan) {
      var network = netfluxNetwork;
      // originally implemented as part of 'saveRoutine', abstracted logic
      // such that the merge/save algorithm can terminate with different
      // callbacks for different use cases
      var saveFinalizer = function(e, shouldSave) {
        var toSave = mainConfig.getTextValue();
        if (toSave === null) {
          e = "Unable to get the content of the document. Don't save.";
        }
        if (e) {
          warn(e);
          return;
        } else if (shouldSave) {
          saveDocument(mainConfig.getSaveValue(), function() {
            // cache this because bumpVersion will increment it
            var lastVersion = lastSaved.version;

            // update values in lastSaved
            updateLastSaved(toSave);

            // get document version
            bumpVersion(function(out) {
              if (out.version === "1.1") {
                debug("Created document version 1.1");
              } else {
                debug("Version bumped from " + lastVersion + " to " + out.version + ".");
              }
              lastSaved.mergeMessage('saved',[out.version]);
            }, null);
          });
          return;
        } else {
          // local content matches that of the latest version
          verbose("No save was necessary");
          lastSaved.content = toSave;
          // didn't save, don't need a callback
          bumpVersion();
          return;
        }
      };

      var saveRoutine = function(andThen, force, autosave) {
        // if this is ever true in your save routine, complain and abort
        lastSaved.receivedISAVE = false;

        var toSave = mainConfig.getTextValue();
        if (toSave === null) {
          warn("Unable to get the content of the document. Don't save.");
          return;
        }

        if (lastSaved.content === toSave && !force ) {
          verbose("No changes made since last save. Avoiding unnecessary commits");
          return;
        }

        if (mainConfig.mergeContent) {
          mergeRoutine(andThen);
        } else {
          mainConfig.safeSave(false, false, {
            version: lastSaved.version,
            versionTime: lastSaved.time
          }, function() {
            andThen(null, true);
          });
        }
      }; // end saveRoutine

      var saveButtonAction = function(cont) {
        debug("createSaver.saveand" + (cont ? 'view' : 'continue'));

        // name this flag for readability
        var force = true;
        saveRoutine(function(e) {
          if (e) {
            warn(e);
          }

          lastSaved.shouldRedirect = cont;
          // fire save event
          document.fire('xwiki:actions:save', {
            form: $('#'+config.formId)[0],
            continue: 1
          });
        }, force, cont);
      };

      // replace callbacks for the save and view button
      $('[name="action_save"]').off('click').click(function(e) {
        e.preventDefault();
        if ($(this).attr('disabled') === 'disabled') {
          return;
        }
        // arg is 'shouldRedirect'
        saveButtonAction(true);
      });

      // replace callbacks for the save and continue button
      var $sac = $('[name="action_saveandcontinue"]');
      $sac[0].stopObserving();
      $sac.off('click').click(function(e) {
        e.preventDefault();
        // should redirect?
        if ($(this).attr('disabled') === 'disabled') {
          return;
        }
        saveButtonAction(false);
      });

      // there's a very small chance that the preview button might cause
      // problems, so let's just get rid of it
      $('[name="action_preview"]').remove();

      // wait to get saved event
      var onSavedHandler = mainConfig.onSaved = function(ev) {
        // this means your save has worked
        // cache the last version
        var lastVersion = lastSaved.version;
        var toSave = mainConfig.getTextValue();
        // update your content
        updateLastSaved(toSave);

        ajaxVersion(function(e, out) {
          if (e) {
            // there was an error (probably ajax)
            warn(e);
            ErrorBox.show('save');
          } else if (out.isNew) {
            // it didn't actually save?
            ErrorBox.show('save');
          } else {
            lastSaved.onReceiveOwnIsave = function() {
              // once you get your isaved back, redirect
              debug("lastSaved.shouldRedirect " + lastSaved.shouldRedirect);
              if (lastSaved.shouldRedirect) {
                debug('createSaver.saveandview.receivedOwnIsaved');
                debug("redirecting!");
                redirectToView();
              } else {
                debug('createSaver.saveandcontinue.receivedOwnIsaved');
              }
              // clean up after yourself..
              lastSaved.onReceiveOwnIsave = null;
            };
            // bump the version, fire your isaved
            bumpVersion(function(out) {
              if (out.version === "1.1") {
                debug("Created document version 1.1");
              } else {
                debug("Version bumped from " + lastVersion + " to " + out.version + ".");
              }
              lastSaved.mergeMessage("saved", [out.version]);
            }, out);
          }
        });
        return true;
      };
      document.stopObserving('xwiki:document:saved');
      document.observe('xwiki:document:saved', onSavedHandler);

      var onSaveFailedHandler = mainConfig.onSaveFailed = function(ev) {
        var debugLog = {
          state: 'savedFailed',
          lastSavedVersion: lastSaved.version,
          lastSavedContent: lastSaved.content,
          cUser: mainConfig.userName,
          cContent: mainConfig.getTextValue()
        };
        if (ev.memo.response.status == 409) {
         console.log("XWiki conflict system detected. No RT error box should be shown");
        } else {
         ErrorBox.show('save', JSON.stringify(debugLog));
         warn("save failed!!!");
         console.log(ev);
        }
      };
      document.stopObserving('xwiki:document:saveFailed');
      document.observe("xwiki:document:saveFailed", onSaveFailedHandler);

      // TimeOut
      var check = function() {
        clearTimeout(mainConfig.autosaveTimeout);
        verbose("createSaver.check");
        var periodDuration = Math.random() * SAVE_DOC_CHECK_CYCLE;
        mainConfig.autosaveTimeout = setTimeout(check, periodDuration);

        verbose("Will attempt to save again in " + periodDuration +"ms.");

        if (!lastSaved.wasEditedLocally) {
          verbose("Skipping save routine because no changes have been made locally");
          return;
        } else {
          verbose("There have been local changes!");
        }
        if (now() - lastSaved.time < SAVE_DOC_TIME) {
          verbose("(Now - lastSaved.time) < SAVE_DOC_TIME");
          return;
        }
        // avoid queuing up multiple merge dialogs
        if (mergeDialogCurrentlyDisplayed) {
          return;
        }

        // demoMode lets the user preview realtime behaviour
        // without actually requiring permission to save
        if (demoMode) {
          return;
        }

        saveRoutine(saveFinalizer);
      }; // end check

      check();

      /* Stop the autosaver when the websocket connection is closed. If reconnecting-websocket
        manages to reconnect, update only the version. If the application using the autosaver 
        handles reconnections, it has to recreate the saver when the websockets are up again.

        NOTE: A reconnection script directly in saver.js may break the entire saving system of the
           document. If the saver manages reconnections but not the main application, it would result
           in merges of an offline document (with potential merge errors due to version mismatch)
      */
    };

    var rtConfig = {
      initialState: '{}',
      network: netfluxNetwork,
      userName: mainConfig.userName || '',
      channel: channel,
      crypto: Crypto || null
    };
    var module = window.SAVER_MODULE = {};
    mainConfig.initializing = true;
    var onRemote = rtConfig.onRemote = function(info) {
      if (mainConfig.initializing) {
        return;
      }

      try {
        var data = JSON.parse(module.chainpad.getUserDoc());
        onMessage(data);
      } catch (e) {
        warn("Unable to parse realtime data from the saver", e);
      }
    };
    var onReady = rtConfig.onReady = function(info) {
      module.chainpad = mainConfig.chainpad = info.realtime;
      module.leave = mainConfig.leaveChannel = info.leave;
      try {
        var data = JSON.parse(module.chainpad.getUserDoc());
        onMessage(data);
      } catch (e) {
        warn("Unable to parse realtime data from the saver", e);
      }
      mainConfig.initializing = false;
      onOpen();
    };
    var onLocal = rtConfig.onLocal = mainConfig.onLocal = function(info) {
      if (mainConfig.initializing) {
        return;
      }
      var sjson = stringify(rtData);
      module.chainpad.contentUpdate(sjson);
      if (module.chainpad.getUserDoc() !== sjson) {
        warn("Saver: userDoc !== sjson");
      }
    };
    var onAbort = rtConfig.onAbort = function() {
      Saver.stop();
    };
    realtimeInput.start(rtConfig);
  }; // END createSaver

  // Stop the autosaver/merge when the user disallows realtime or when the websocket is disconnected
  Saver.stop = function() {
    if (mainConfig.realtime) {
      mainConfig.realtime.abort();
    }
    if (mainConfig.leaveChannel) {
      mainConfig.leaveChannel();
      delete mainConfig.leaveChannel;
    }
    clearTimeout(mainConfig.autosaveTimeout);
    rtData = {};
    // Remove the merge routine from the save buttons
    document.stopObserving('xwiki:document:saved');
    document.stopObserving('xwiki:document:saveFailed');
    // remove callbacks for the save and view button
    // the button will now submit the "Save and view" form
    $('[name="action_save"]').off('click').click(function(e) {
      if ($(this).attr('disabled') === 'disabled') {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // replace callbacks for the save and continue button
    $('[name="action_saveandcontinue"]').off('click').click(function(e) {
      e.preventDefault();
      if ($(this).attr('disabled') === 'disabled') {
        return;
      }
      // fire save event
      document.fire('xwiki:actions:save', {
        form: $('#'+mainConfig.formId)[0],
        continue: 1
      });
    });
  };

  Saver.setLastSavedContent = function(content) {
    lastSaved.content = content;
  };

  return Saver;
});
