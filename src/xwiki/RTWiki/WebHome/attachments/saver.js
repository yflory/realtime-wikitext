define([
    'jquery',
], function ($) {
    var warn = function (x) {};
    var debug = function (x) {};
    // there was way too much noise, if you want to know everything use verbose
    var verbose = function (x) {};
    //verbose = function (x) { console.log(x); };
    debug = function (x) { console.log(x) };
    warn = function (x) { console.log(x) };

    // Number for a message type which will not interfere with chainpad.
    var MESSAGE_TYPE_ISAVED = 5000;

    var SAVE_DOC_TIME = 60000;

    // how often to check if the document has been saved recently
    var SAVE_DOC_CHECK_CYCLE = 20000;

    var now = function () { return (new Date()).getTime(); };

    

    var Saver = {};

    var mainConfig = Saver.mainConfig = {};

    var configure = Saver.configure = function (config) {
        mainConfig.ajaxMergeUrl =  config.ajaxMergeUrl + '?xpage=plain&outputSyntax=plain';
        mainConfig.language = config.language;
    };

    var lastSaved = Saver.lastSaved = {
        content: '',
        version: $('html').data('xwiki-version'),
        time: 0,
        // http://jira.xwiki.org/browse/RTWIKI-37
        hasModifications: false,
        // for future tracking of 'edited since last save'
        // only show the merge dialog to those who have edited
        wasEditedLocally: false,
        receivedISAVE: false,
        shouldRedirect: false,
        isavedSignature: ''
    };

    var updateLastSaved = Saver.update = function (content) {
        lastSaved.time = now();
        lastSaved.content = content;
        lastSaved.wasEditedLocally = false;
    };

    var isaveInterrupt = Saver.interrupt = function () {
        if (lastSaved.receivedISAVE) {
            warn("Another client sent an ISAVED message.");
            warn("Aborting save action");
            // unset the flag, or else it will persist
            lastSaved.receivedISAVE = false;
            // return true such that calling functions know to abort
            return true;
        }
        return false;
    };

    /* retrieves attributes about the local document for the purposes of ajax merge
        just data-xwiki-document and lastSaved.version
    */
    var getDocumentStatistics = function () {
        var $html = $('html'),
            fields = [
                // 'space', 'page',
                'wiki',
                'document' // includes space and page
            ],
            result = {};

        /*  we can't rely on people pushing the new lastSaved.version
            if they quit before ISAVED other clients won't get the new version
            this isn't such an issue, because they _will_ converge eventually
        */
        result.version = lastSaved.version;

        fields.forEach(function (field) {
            result[field] = $html.data('xwiki-'+field);
        });

        return result;
    };

    var ajaxMerge = function (content, cb) {
        // outputSyntax=plain is no longer necessary
        var url = mainConfig.ajaxMergeUrl + '?xpage=plain&outputSyntax=plain';

        /* version, document */
        var stats=getDocumentStatistics();

        stats.content = content;

        console.log("Posting with the following stats");
        console.log(stats);

        $.ajax({
            url: url,
            method: 'POST',
            success: function (data) {
                try {
                    var merge=JSON.parse(data);

                    window.alert("Merged!");
                    window.ansuz_merge = merge;
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
                    ErrorBox.show('parse');
                    warn(err);
                    cb(err, data);
                }
            },
            data: stats,
            error: function (err) {
                warn(err);
                cb(err,null);
            },
        });
    };

    // check a serverside api for the version string of the document
    var ajaxVersion = function (cb) {
        var url = mainConfig.ajaxVersionUrl + '?xpage=plain';
        var stats = getDocumentStatistics();
        $.ajax({
            url: url,
            method: 'POST',
            dataType: 'json',
            success: function (data) {
                cb(null, data);
            },
            data: stats,
            error: function (err) {
                cb(err, null);
            }
        });
    };

    var bumpVersion = function (socket, channel, myUserName, cb) {
        ajaxVersion(function (e, out) {
            if (e) {
                warn(e);
            } else if (out) {
                debug("Triggering lastSaved refresh on remote clients");
                lastSaved.version = out.version;
                saveMessage(socket, channel, myUserName, lastSaved.version);
                cb && cb(out);
            } else {
                throw new Error();
            }
        });
    };

    var getFormToken = Saver.getFormToken = function () {
        return $('meta[name="form_token"]').attr('content');
    };


    // http://jira.xwiki.org/browse/RTWIKI-29
    var saveDocument = function (content, config, andThen) {
        /* RT_event-on_save */
        debug("saving document...");

        var data = {
            // title if can be done realtime
            xredirect: '',
            content: content,
            xeditaction: 'edit',
            // TODO make this translatable
            comment: 'Auto-Saved by Realtime Session',
            action_saveandcontinue: 'Save & Continue',
            minorEdit: 1,
            ajax: true,
            form_token: getFormToken(),
            language: mainConfig.language
        };

        // override default data with configuration
        Object.keys(config).forEach(function (key) {
            data[key] = config[key];
        });

        $.ajax({
            url: window.docsaveurl,
            type: "POST",
            async: true,
            dataType: 'text',

            // http://jira.xwiki.org/browse/RTWIKI-36
            // don't worry about hijacking and resuming
            // if you can just add the usual fields to this, simply steal the event
            data: data,
            success: function () {
                andThen();
            },
            error: function (jqxhr, err, cause) {
                warn(err);
                // Don't callback, this way in case of error we will keep trying.
                //andThen();
            }
        });
    };

    // sends an ISAVED message
    var saveMessage=function (socket, channel, myUserName, version) {
        debug("saved document"); // RT_event-on_save
        var saved = JSON.stringify([MESSAGE_TYPE_ISAVED, version]);
        // show(saved(version))
        lastSaved.mergeMessage('saved', [version]);
        socket.send('1:x' +
            myUserName.length + ':' + myUserName +
            channel.length + ':' + channel +
            saved.length + ':' + saved
        );
    };

    var presentMergeDialog = function(question, labelDefault, choiceDefault, labelAlternative, choiceAlternative){
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
    };

    var destroyDialog = function (cb) {
        var $box = $('.xdialog-box.xdialog-box-confirmation'),
            $question = $box.find('.question'),
            $content = $box.find('.xdialog-content');
        if ($box.length) {
            $content.find('.button.cancel').click();
            cb && cb(true);
        } else {
            cb && cb(false);
        }
    };

    // only used within 'createSaver'
    var redirectToView = function () {
        window.location.href = window.XWiki.currentDocument.getURL('view');
    };

    // FIXME have rtwiki call this on local edits
    var setLocalEditFlag = Saver.setLocalEditFlag = function (condition) {
        lastSaved.wasEditedLocally = condition;
    };

    /*
        createSaver contains some of the more complicated logic in this script
        clients check for remote changes on random intervals

        if another client has saved outside of the realtime session, changes
        are merged on the server using XWiki's threeway merge algo.

        The changes are integrated into the local textarea, which replicates
        across realtime sessions.

        if the resulting state does not match the last saved content, then the
        contents are saved as a new version.

        Other members of the session are notified of the save, and the
        iesulting new version. They then update their local state to match.

        During this process, a series of checks are made to reduce the number
        of unnecessary saves, as well as the number of unnecessary merges.
    */
    var createSaver = Saver.create = function (socket, channel, myUserName, textArea, demoMode, language, messages) {

        /*  TODO called from sharejs_textarea
            this is deprecated from realtime-input

            you should call Saver.setLocalEditFlag(true) from onLocal */
        socket.realtime.localChange = function (condition) {
            setLocalEditFlag(condition);
        };

        lastSaved.time = now();
        var mergeDialogCurrentlyDisplayed = false;

        /* ISAVED listener */
        socket.onMessage.unshift(function (evt) {
            // set a flag so any concurrent processes know to abort
            lastSaved.receivedISAVE = true;

            // get the content...
            var chanIdx = evt.data.indexOf(channel);
            var content = evt.data.substring(evt.data.indexOf(':[', chanIdx + channel.length)+1);

            // parse
            var json = JSON.parse(content);

            // not an isaved message
            if (json[0] !== MESSAGE_TYPE_ISAVED) { return; }

            /*  RT_event-on_isave_receive

                clients update lastSaved.version when they perform a save,
                then they send an ISAVED with the version
                a single user might have multiple windows open, for some reason
                but might still have different save cycles
                checking whether the received version matches the local version
                tells us whether the ISAVED was set by our *browser*
                if not, we should treat it as foreign.
            */
            if (lastSaved.version !== json[1]) {
                // a merge dialog might be open, if so, remove it and say as much
                destroyDialog(function (dialogDestroyed) {
                    if (dialogDestroyed) {
                        // tell the user about the merge resolution
                        lastSaved.mergeMessage('conflictResolved', [json[1]]);
                    } else {
                        // otherwise say there was a remote save
                        // http://jira.xwiki.org/browse/RTWIKI-34
                        var remoteUser = decodeURIComponent(
                            evt.data.replace(/^[^\-]*-|%2d[^%]*$/g, ''));
                        lastSaved.mergeMessage(
                            'savedRemote',
                            [json[1], remoteUser]);
                    }
                });

                debug("A remote client saved and "+
                    "incremented the latest common ancestor");

                // update lastSaved attributes
                lastSaved.wasEditedLocally = false;

                // update the local latest Common Ancestor version string
                lastSaved.version = json[1];

                // remember the state of the textArea when last saved
                // so that we can avoid additional minor versions
                // there's a *tiny* race condition here
                // but it's probably not an issue
                lastSaved.content = $(textArea).val();
            } else {
                lastSaved.onReceiveOwnIsave && lastSaved.onReceiveOwnIsave();
            }
            lastSaved.time = now();
            return false;
        }); // end onMessage

        // originally implemented as part of 'saveRoutine', abstracted logic
        // such that the merge/save algorithm can terminate with different
        // callbacks for different use cases
        var saveFinalizer = function (e, shouldSave) {
            var toSave = $(textArea).val();
            if (e) {
                warn(e);
                return;
            } else if (shouldSave) {

                var options = {
                    language:language
                };

                saveDocument($(textArea).val(), options, function () {
                    // cache this because bumpVersion will increment it
                    var lastVersion = lastSaved.version;

                    // update values in lastSaved
                    updateLastSaved(toSave);

                    // get document version
                    bumpVersion(socket, channel, myUserName, function (out){
                        if (out.version === "1.1") {
                            debug("Created document version 1.1");
                        } else {
                            debug("Version bumped from " + lastVersion +
                                " to " + out.version + ".");
                        }
                        lastSaved.mergeMessage('saved',[out.version]);
                    });
                });
                return;
            } else {
                // local content matches that of the latest version
                verbose("No save was necessary");
                lastSaved.content = toSave;
                // didn't save, don't need a callback
                bumpVersion(socket, channel, myUserName);
                return;
            }
        };

        var saveRoutine = function (andThen, force) {
            // if this is ever true in your save routine, complain and abort
            lastSaved.receivedISAVE = false;

            var toSave = $(textArea).val();
            if (lastSaved.content === toSave && !force ) {
                verbose("No changes made since last save. "+
                    "Avoiding unnecessary commits");
                return;
            }

            // post your current version to the server to see if it must merge
            // remember the current state so you can check if it has changed.
            var preMergeContent = $(textArea).val();
            ajaxMerge($(textArea).val(), function (err, merge) {
                if (err) {
                    if (typeof merge === 'undefined') {
                        warn("The ajax merge API did not return an object. "+
                            "Something went wrong");
                        warn(err);
                        return;
                    } else if (err === merge.error) { // there was a merge error
                        // continue and handle elsewhere
                        warn(err);
                    } else {
                        // it was some other kind of error... parsing?
                        // complain and return. this means the script failed
                        warn(err);
                        return;
                    }
                }

                if (isaveInterrupt()) {
                    andThen("ISAVED interrupt", null);
                    return;
                }

                toSave = merge.content;
                if (toSave === lastSaved.content) {
                    debug("Merging didn't result in a change.");
/* FIXME merge on load isn't working
                    if (force) {
                        debug("Force option was passed, merging anyway.");
                    } else { */
                        // don't dead end, but indicate that you shouldn't save.
                        andThen("Merging didn't result in a change.", false);
                        return;
//                    }
                }

                var $textArea = $(textArea);

                var continuation = function (callback) {
                    // callback takes signature (err, shouldSave)

                    // our continuation has three cases:
                    if (isaveInterrupt()) {
                    // 1. ISAVE interrupt error
                        callback("ISAVED interrupt", null);
                    } else if (merge.saveRequired) {
                    // 2. saveRequired
                        callback(null, true);
                    } else {
                    // 3. saveNotRequired
                        callback(null, false);
                    }
                }; // end continuation

                // http://jira.xwiki.org/browse/RTWIKI-34
                // Give Messages when merging
                if (merge.merged) {
                    // a merge took place
                    if (merge.error) {
                        // but there was a conflict we'll need to resolve.
                        warn(merge.error)

                        // halt the autosave cycle to give the user time
                        // don't halt forever though, because you might
                        // disconnect and hang
                        mergeDialogCurrentlyDisplayed = true;
                        presentMergeDialog(
                            messages.mergeDialog_prompt,

                            messages.mergeDialog_keepRealtime,
                            function () {
                                debug("User chose to use the realtime version!");
                                // unset the merge dialog flag
                                mergeDialogCurrentlyDisplayed = false;
                                continuation(andThen);
                            },

                            messages.mergeDialog_keepRemote,
                            function () {
                                debug("User chose to use the remote version!");
                                // unset the merge dialog flag
                                mergeDialogCurrentlyDisplayed = false;

                                $.ajax({
                                    url: XWiki.currentDocument.getRestURL()+'?media=json',
                                    method: 'GET',
                                    dataType: 'json',
                                    success: function (data) {
                                        $textArea.val(data.content);
                                        socket.realtime.bumpSharejs();

                                        debug("Overwrote the realtime session's content with the latest saved state");
                                        bumpVersion(socket, channel, myUserName, function () {
                                            lastSaved.mergeMessage('merge overwrite',[]);
                                        });
                                        continuation(andThen);
                                    },
                                    error: function (err) {
                                        warn("Encountered an error while fetching remote content");
                                        warn(err);
                                    }
                                });
                            }
                        );
                        return; // escape from the save process
                        // when the merge dialog is answered it will continue
                    } else {
                        // it merged and there were no errors
                        if (preMergeContent !== $textArea.val()) {
                            /* but there have been changes since merging
                                don't overwrite if there have been changes while merging
                                http://jira.xwiki.org/browse/RTWIKI-37 */

                            andThen("The realtime content changed while we "+
                                "were performing our asynchronous merge.",
                                false);
                            return; // try again in one cycle
                        } else {
                            // walk the tree of hashes and if merge.previousVersionContent
                            // exists, then this merge is quite possibly faulty

                            if (socket.realtime.wasEverState(merge.previousVersionContent)) {
                                debug("The server merged a version which already existed in the history. " +
                                    "Reversions shouldn't merge. Ignoring merge");

                                debug("waseverstate=true");
                                continuation(andThen);
                                return;
                            } else {
                                debug("The latest version content does not exist anywhere in our history");
                                debug("Continuing...");
                            }

                            // there were no errors or local changes push to the textarea
                            $textArea.val(toSave);
                            // bump sharejs to force propogation. only if changed
                            socket.realtime.bumpSharejs();
                            // TODO show message informing the user
                            // which versions were merged...
                            continuation(andThen);
                        }
                    }
                } else {
                    // no merge was necessary, but you might still have to save
                    // pass in a callback...
                    continuation(andThen);
                }
            });
        }; // end saveRoutine

        var saveButtonAction = function (cont) {
            debug("createSaver.saveand"+(cont?"view":"continue"));

            // name this flag for readability
            var force = true;
            saveRoutine(function (e, shouldSave) {
                var toSave = $(textArea).val();
                if (e) {
                    warn(e);
                    //return;
                }

                lastSaved.shouldRedirect = cont;
                // fire save event
                document.fire('xwiki:actions:save', {
                    form: $('#edit')[0],
                    continue: 1
                });
            }, force);
        };

        // replace callbacks for the save and view button
        $('[name="action_save"]')
            .off('click')
            .click(function (e) {
                e.preventDefault();
                // arg is 'shouldRedirect'
                saveButtonAction (true);
            });

        // replace callbacks for the save and continue button
        var $sac = $('[name="action_saveandcontinue"]');
        $sac[0].stopObserving();
        $sac.click(function (e) {
            e.preventDefault();
            // should redirect?
            saveButtonAction(false);
        });

        // there's a very small chance that the preview button might cause
        // problems, so let's just get rid of it
        $('[name="action_preview"]').remove();

        // wait to get saved event
        document.observe('xwiki:document:saved', function (ev) {
            // this means your save has worked

            // cache the last version
            var lastVersion = lastSaved.version;
            var toSave = $(textArea).val();

            // update your content
            updateLastSaved(toSave);

            ajaxVersion(function (e, out) {
                if (e) {
                    // there was an error (probably ajax)
                    warn(e);
                    ErrorBox.show('save');
                } else if (out.isNew) {
                    // it didn't actually save?
                    ErrorBox.show('save');
                } else {
                    lastSaved.onReceiveOwnIsave = function () {
                        // once you get your isaved back, redirect
                        debug("lastSaved.shouldRedirect " +
                            lastSaved.shouldRedirect);
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
                    bumpVersion(socket, channel, myUserName, function (out) {
                        if (out.version === "1.1") {
                            debug("Created document version 1.1");
                        } else {
                            debug("Version bumped from " + lastVersion +
                                " to " + out.version + ".");
                        }
                        lastSaved.mergeMessage("saved", [out.version]);
                    });
                }
            });
            return true;
        });

        document.observe("xwiki:document:saveFailed", function (ev) {
            ErrorBox.show('save');
            warn("save failed!!!");
        });

        // TimeOut
        var to;

        var check = function () {
            if (to) { clearTimeout(to); }
            verbose("createSaver.check");
            var periodDuration = Math.random() * SAVE_DOC_CHECK_CYCLE;
            to = setTimeout(check, periodDuration);

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
            if (mergeDialogCurrentlyDisplayed) { return; }

            // demoMode lets the user preview realtime behaviour
            // without actually requiring permission to save
            if (demoMode) { return; }

            saveRoutine(saveFinalizer);
        }; // end check

/*
        (function(){
            var force = true;
            var id="secret-merge";
            $('.rtwiki-toolbar').prepend('<a href="#" id="'+id+'">force merge</a>');
            $('#'+id).click(function (e) {
                e.preventDefault();
                saveRoutine(saveFinalizer, force);
            })
            .click(); // this should merge your page on load
            // ensuring that all clients are up to date.
        }());   */

        check();
        socket.onClose.push(function () {
            clearTimeout(to);
        });
    }; // END createSaver

    Saver.setLastSavedContent = function (content) {
        lastSaved.content = content;
    };
    
    return Saver;
});
