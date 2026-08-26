// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint, type=warning, deprecated_member_use, deprecated_member_use_from_same_package
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'simple.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// GENERATED CODE - DO NOT MODIFY BY HAND
// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$DesktopCommand {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'DesktopCommand()';
}


}

/// @nodoc
class $DesktopCommandCopyWith<$Res>  {
$DesktopCommandCopyWith(DesktopCommand _, $Res Function(DesktopCommand) __);
}


/// Adds pattern-matching-related methods to [DesktopCommand].
extension DesktopCommandPatterns on DesktopCommand {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( DesktopCommand_SessionReady value)?  sessionReady,TResult Function( DesktopCommand_ConfigureRoute value)?  configureRoute,TResult Function( DesktopCommand_StartAudio value)?  startAudio,TResult Function( DesktopCommand_EndAudio value)?  endAudio,TResult Function( DesktopCommand_RunAzookey value)?  runAzookey,TResult Function( DesktopCommand_RunTranslation value)?  runTranslation,TResult Function( DesktopCommand_StopSession value)?  stopSession,TResult Function( DesktopCommand_SetTranslationEnabled value)?  setTranslationEnabled,TResult Function( DesktopCommand_Ping value)?  ping,required TResult orElse(),}){
final _that = this;
switch (_that) {
case DesktopCommand_SessionReady() when sessionReady != null:
return sessionReady(_that);case DesktopCommand_ConfigureRoute() when configureRoute != null:
return configureRoute(_that);case DesktopCommand_StartAudio() when startAudio != null:
return startAudio(_that);case DesktopCommand_EndAudio() when endAudio != null:
return endAudio(_that);case DesktopCommand_RunAzookey() when runAzookey != null:
return runAzookey(_that);case DesktopCommand_RunTranslation() when runTranslation != null:
return runTranslation(_that);case DesktopCommand_StopSession() when stopSession != null:
return stopSession(_that);case DesktopCommand_SetTranslationEnabled() when setTranslationEnabled != null:
return setTranslationEnabled(_that);case DesktopCommand_Ping() when ping != null:
return ping(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( DesktopCommand_SessionReady value)  sessionReady,required TResult Function( DesktopCommand_ConfigureRoute value)  configureRoute,required TResult Function( DesktopCommand_StartAudio value)  startAudio,required TResult Function( DesktopCommand_EndAudio value)  endAudio,required TResult Function( DesktopCommand_RunAzookey value)  runAzookey,required TResult Function( DesktopCommand_RunTranslation value)  runTranslation,required TResult Function( DesktopCommand_StopSession value)  stopSession,required TResult Function( DesktopCommand_SetTranslationEnabled value)  setTranslationEnabled,required TResult Function( DesktopCommand_Ping value)  ping,}){
final _that = this;
switch (_that) {
case DesktopCommand_SessionReady():
return sessionReady(_that);case DesktopCommand_ConfigureRoute():
return configureRoute(_that);case DesktopCommand_StartAudio():
return startAudio(_that);case DesktopCommand_EndAudio():
return endAudio(_that);case DesktopCommand_RunAzookey():
return runAzookey(_that);case DesktopCommand_RunTranslation():
return runTranslation(_that);case DesktopCommand_StopSession():
return stopSession(_that);case DesktopCommand_SetTranslationEnabled():
return setTranslationEnabled(_that);case DesktopCommand_Ping():
return ping(_that);}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( DesktopCommand_SessionReady value)?  sessionReady,TResult? Function( DesktopCommand_ConfigureRoute value)?  configureRoute,TResult? Function( DesktopCommand_StartAudio value)?  startAudio,TResult? Function( DesktopCommand_EndAudio value)?  endAudio,TResult? Function( DesktopCommand_RunAzookey value)?  runAzookey,TResult? Function( DesktopCommand_RunTranslation value)?  runTranslation,TResult? Function( DesktopCommand_StopSession value)?  stopSession,TResult? Function( DesktopCommand_SetTranslationEnabled value)?  setTranslationEnabled,TResult? Function( DesktopCommand_Ping value)?  ping,}){
final _that = this;
switch (_that) {
case DesktopCommand_SessionReady() when sessionReady != null:
return sessionReady(_that);case DesktopCommand_ConfigureRoute() when configureRoute != null:
return configureRoute(_that);case DesktopCommand_StartAudio() when startAudio != null:
return startAudio(_that);case DesktopCommand_EndAudio() when endAudio != null:
return endAudio(_that);case DesktopCommand_RunAzookey() when runAzookey != null:
return runAzookey(_that);case DesktopCommand_RunTranslation() when runTranslation != null:
return runTranslation(_that);case DesktopCommand_StopSession() when stopSession != null:
return stopSession(_that);case DesktopCommand_SetTranslationEnabled() when setTranslationEnabled != null:
return setTranslationEnabled(_that);case DesktopCommand_Ping() when ping != null:
return ping(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( String sessionId,  PipelineRoute route)?  sessionReady,TResult Function( PipelineRoute route)?  configureRoute,TResult Function( String sessionId,  BigInt turnId,  BigInt revision)?  startAudio,TResult Function( String sessionId,  BigInt turnId,  BigInt revision)?  endAudio,TResult Function( String sessionId,  BigInt turnId,  BigInt revision,  String text,  bool isFinal)?  runAzookey,TResult Function( String sessionId,  BigInt turnId,  BigInt revision,  String sourceText)?  runTranslation,TResult Function( String sessionId)?  stopSession,TResult Function( bool enabled)?  setTranslationEnabled,TResult Function( BigInt nonce)?  ping,required TResult orElse(),}) {final _that = this;
switch (_that) {
case DesktopCommand_SessionReady() when sessionReady != null:
return sessionReady(_that.sessionId,_that.route);case DesktopCommand_ConfigureRoute() when configureRoute != null:
return configureRoute(_that.route);case DesktopCommand_StartAudio() when startAudio != null:
return startAudio(_that.sessionId,_that.turnId,_that.revision);case DesktopCommand_EndAudio() when endAudio != null:
return endAudio(_that.sessionId,_that.turnId,_that.revision);case DesktopCommand_RunAzookey() when runAzookey != null:
return runAzookey(_that.sessionId,_that.turnId,_that.revision,_that.text,_that.isFinal);case DesktopCommand_RunTranslation() when runTranslation != null:
return runTranslation(_that.sessionId,_that.turnId,_that.revision,_that.sourceText);case DesktopCommand_StopSession() when stopSession != null:
return stopSession(_that.sessionId);case DesktopCommand_SetTranslationEnabled() when setTranslationEnabled != null:
return setTranslationEnabled(_that.enabled);case DesktopCommand_Ping() when ping != null:
return ping(_that.nonce);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( String sessionId,  PipelineRoute route)  sessionReady,required TResult Function( PipelineRoute route)  configureRoute,required TResult Function( String sessionId,  BigInt turnId,  BigInt revision)  startAudio,required TResult Function( String sessionId,  BigInt turnId,  BigInt revision)  endAudio,required TResult Function( String sessionId,  BigInt turnId,  BigInt revision,  String text,  bool isFinal)  runAzookey,required TResult Function( String sessionId,  BigInt turnId,  BigInt revision,  String sourceText)  runTranslation,required TResult Function( String sessionId)  stopSession,required TResult Function( bool enabled)  setTranslationEnabled,required TResult Function( BigInt nonce)  ping,}) {final _that = this;
switch (_that) {
case DesktopCommand_SessionReady():
return sessionReady(_that.sessionId,_that.route);case DesktopCommand_ConfigureRoute():
return configureRoute(_that.route);case DesktopCommand_StartAudio():
return startAudio(_that.sessionId,_that.turnId,_that.revision);case DesktopCommand_EndAudio():
return endAudio(_that.sessionId,_that.turnId,_that.revision);case DesktopCommand_RunAzookey():
return runAzookey(_that.sessionId,_that.turnId,_that.revision,_that.text,_that.isFinal);case DesktopCommand_RunTranslation():
return runTranslation(_that.sessionId,_that.turnId,_that.revision,_that.sourceText);case DesktopCommand_StopSession():
return stopSession(_that.sessionId);case DesktopCommand_SetTranslationEnabled():
return setTranslationEnabled(_that.enabled);case DesktopCommand_Ping():
return ping(_that.nonce);}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( String sessionId,  PipelineRoute route)?  sessionReady,TResult? Function( PipelineRoute route)?  configureRoute,TResult? Function( String sessionId,  BigInt turnId,  BigInt revision)?  startAudio,TResult? Function( String sessionId,  BigInt turnId,  BigInt revision)?  endAudio,TResult? Function( String sessionId,  BigInt turnId,  BigInt revision,  String text,  bool isFinal)?  runAzookey,TResult? Function( String sessionId,  BigInt turnId,  BigInt revision,  String sourceText)?  runTranslation,TResult? Function( String sessionId)?  stopSession,TResult? Function( bool enabled)?  setTranslationEnabled,TResult? Function( BigInt nonce)?  ping,}) {final _that = this;
switch (_that) {
case DesktopCommand_SessionReady() when sessionReady != null:
return sessionReady(_that.sessionId,_that.route);case DesktopCommand_ConfigureRoute() when configureRoute != null:
return configureRoute(_that.route);case DesktopCommand_StartAudio() when startAudio != null:
return startAudio(_that.sessionId,_that.turnId,_that.revision);case DesktopCommand_EndAudio() when endAudio != null:
return endAudio(_that.sessionId,_that.turnId,_that.revision);case DesktopCommand_RunAzookey() when runAzookey != null:
return runAzookey(_that.sessionId,_that.turnId,_that.revision,_that.text,_that.isFinal);case DesktopCommand_RunTranslation() when runTranslation != null:
return runTranslation(_that.sessionId,_that.turnId,_that.revision,_that.sourceText);case DesktopCommand_StopSession() when stopSession != null:
return stopSession(_that.sessionId);case DesktopCommand_SetTranslationEnabled() when setTranslationEnabled != null:
return setTranslationEnabled(_that.enabled);case DesktopCommand_Ping() when ping != null:
return ping(_that.nonce);case _:
  return null;

}
}

}

/// @nodoc


class DesktopCommand_SessionReady extends DesktopCommand {
  const DesktopCommand_SessionReady({required this.sessionId, required this.route}): super._();


 final  String sessionId;
 final  PipelineRoute route;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DesktopCommand_SessionReadyCopyWith<DesktopCommand_SessionReady> get copyWith => _$DesktopCommand_SessionReadyCopyWithImpl<DesktopCommand_SessionReady>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand_SessionReady&&(identical(other.sessionId, sessionId) || other.sessionId == sessionId)&&(identical(other.route, route) || other.route == route));
}


@override
int get hashCode => Object.hash(runtimeType,sessionId,route);

@override
String toString() {
  return 'DesktopCommand.sessionReady(sessionId: $sessionId, route: $route)';
}


}

/// @nodoc
abstract mixin class $DesktopCommand_SessionReadyCopyWith<$Res> implements $DesktopCommandCopyWith<$Res> {
  factory $DesktopCommand_SessionReadyCopyWith(DesktopCommand_SessionReady value, $Res Function(DesktopCommand_SessionReady) _then) = _$DesktopCommand_SessionReadyCopyWithImpl;
@useResult
$Res call({
 String sessionId, PipelineRoute route
});




}
/// @nodoc
class _$DesktopCommand_SessionReadyCopyWithImpl<$Res>
    implements $DesktopCommand_SessionReadyCopyWith<$Res> {
  _$DesktopCommand_SessionReadyCopyWithImpl(this._self, this._then);

  final DesktopCommand_SessionReady _self;
  final $Res Function(DesktopCommand_SessionReady) _then;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? sessionId = null,Object? route = null,}) {
  return _then(DesktopCommand_SessionReady(
sessionId: null == sessionId ? _self.sessionId : sessionId // ignore: cast_nullable_to_non_nullable
as String,route: null == route ? _self.route : route // ignore: cast_nullable_to_non_nullable
as PipelineRoute,
  ));
}


}

/// @nodoc


class DesktopCommand_ConfigureRoute extends DesktopCommand {
  const DesktopCommand_ConfigureRoute({required this.route}): super._();


 final  PipelineRoute route;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DesktopCommand_ConfigureRouteCopyWith<DesktopCommand_ConfigureRoute> get copyWith => _$DesktopCommand_ConfigureRouteCopyWithImpl<DesktopCommand_ConfigureRoute>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand_ConfigureRoute&&(identical(other.route, route) || other.route == route));
}


@override
int get hashCode => Object.hash(runtimeType,route);

@override
String toString() {
  return 'DesktopCommand.configureRoute(route: $route)';
}


}

/// @nodoc
abstract mixin class $DesktopCommand_ConfigureRouteCopyWith<$Res> implements $DesktopCommandCopyWith<$Res> {
  factory $DesktopCommand_ConfigureRouteCopyWith(DesktopCommand_ConfigureRoute value, $Res Function(DesktopCommand_ConfigureRoute) _then) = _$DesktopCommand_ConfigureRouteCopyWithImpl;
@useResult
$Res call({
 PipelineRoute route
});




}
/// @nodoc
class _$DesktopCommand_ConfigureRouteCopyWithImpl<$Res>
    implements $DesktopCommand_ConfigureRouteCopyWith<$Res> {
  _$DesktopCommand_ConfigureRouteCopyWithImpl(this._self, this._then);

  final DesktopCommand_ConfigureRoute _self;
  final $Res Function(DesktopCommand_ConfigureRoute) _then;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? route = null,}) {
  return _then(DesktopCommand_ConfigureRoute(
route: null == route ? _self.route : route // ignore: cast_nullable_to_non_nullable
as PipelineRoute,
  ));
}


}

/// @nodoc


class DesktopCommand_StartAudio extends DesktopCommand {
  const DesktopCommand_StartAudio({required this.sessionId, required this.turnId, required this.revision}): super._();


 final  String sessionId;
 final  BigInt turnId;
 final  BigInt revision;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DesktopCommand_StartAudioCopyWith<DesktopCommand_StartAudio> get copyWith => _$DesktopCommand_StartAudioCopyWithImpl<DesktopCommand_StartAudio>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand_StartAudio&&(identical(other.sessionId, sessionId) || other.sessionId == sessionId)&&(identical(other.turnId, turnId) || other.turnId == turnId)&&(identical(other.revision, revision) || other.revision == revision));
}


@override
int get hashCode => Object.hash(runtimeType,sessionId,turnId,revision);

@override
String toString() {
  return 'DesktopCommand.startAudio(sessionId: $sessionId, turnId: $turnId, revision: $revision)';
}


}

/// @nodoc
abstract mixin class $DesktopCommand_StartAudioCopyWith<$Res> implements $DesktopCommandCopyWith<$Res> {
  factory $DesktopCommand_StartAudioCopyWith(DesktopCommand_StartAudio value, $Res Function(DesktopCommand_StartAudio) _then) = _$DesktopCommand_StartAudioCopyWithImpl;
@useResult
$Res call({
 String sessionId, BigInt turnId, BigInt revision
});




}
/// @nodoc
class _$DesktopCommand_StartAudioCopyWithImpl<$Res>
    implements $DesktopCommand_StartAudioCopyWith<$Res> {
  _$DesktopCommand_StartAudioCopyWithImpl(this._self, this._then);

  final DesktopCommand_StartAudio _self;
  final $Res Function(DesktopCommand_StartAudio) _then;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? sessionId = null,Object? turnId = null,Object? revision = null,}) {
  return _then(DesktopCommand_StartAudio(
sessionId: null == sessionId ? _self.sessionId : sessionId // ignore: cast_nullable_to_non_nullable
as String,turnId: null == turnId ? _self.turnId : turnId // ignore: cast_nullable_to_non_nullable
as BigInt,revision: null == revision ? _self.revision : revision // ignore: cast_nullable_to_non_nullable
as BigInt,
  ));
}


}

/// @nodoc


class DesktopCommand_EndAudio extends DesktopCommand {
  const DesktopCommand_EndAudio({required this.sessionId, required this.turnId, required this.revision}): super._();


 final  String sessionId;
 final  BigInt turnId;
 final  BigInt revision;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DesktopCommand_EndAudioCopyWith<DesktopCommand_EndAudio> get copyWith => _$DesktopCommand_EndAudioCopyWithImpl<DesktopCommand_EndAudio>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand_EndAudio&&(identical(other.sessionId, sessionId) || other.sessionId == sessionId)&&(identical(other.turnId, turnId) || other.turnId == turnId)&&(identical(other.revision, revision) || other.revision == revision));
}


@override
int get hashCode => Object.hash(runtimeType,sessionId,turnId,revision);

@override
String toString() {
  return 'DesktopCommand.endAudio(sessionId: $sessionId, turnId: $turnId, revision: $revision)';
}


}

/// @nodoc
abstract mixin class $DesktopCommand_EndAudioCopyWith<$Res> implements $DesktopCommandCopyWith<$Res> {
  factory $DesktopCommand_EndAudioCopyWith(DesktopCommand_EndAudio value, $Res Function(DesktopCommand_EndAudio) _then) = _$DesktopCommand_EndAudioCopyWithImpl;
@useResult
$Res call({
 String sessionId, BigInt turnId, BigInt revision
});




}
/// @nodoc
class _$DesktopCommand_EndAudioCopyWithImpl<$Res>
    implements $DesktopCommand_EndAudioCopyWith<$Res> {
  _$DesktopCommand_EndAudioCopyWithImpl(this._self, this._then);

  final DesktopCommand_EndAudio _self;
  final $Res Function(DesktopCommand_EndAudio) _then;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? sessionId = null,Object? turnId = null,Object? revision = null,}) {
  return _then(DesktopCommand_EndAudio(
sessionId: null == sessionId ? _self.sessionId : sessionId // ignore: cast_nullable_to_non_nullable
as String,turnId: null == turnId ? _self.turnId : turnId // ignore: cast_nullable_to_non_nullable
as BigInt,revision: null == revision ? _self.revision : revision // ignore: cast_nullable_to_non_nullable
as BigInt,
  ));
}


}

/// @nodoc


class DesktopCommand_RunAzookey extends DesktopCommand {
  const DesktopCommand_RunAzookey({required this.sessionId, required this.turnId, required this.revision, required this.text, required this.isFinal}): super._();


 final  String sessionId;
 final  BigInt turnId;
 final  BigInt revision;
 final  String text;
 final  bool isFinal;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DesktopCommand_RunAzookeyCopyWith<DesktopCommand_RunAzookey> get copyWith => _$DesktopCommand_RunAzookeyCopyWithImpl<DesktopCommand_RunAzookey>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand_RunAzookey&&(identical(other.sessionId, sessionId) || other.sessionId == sessionId)&&(identical(other.turnId, turnId) || other.turnId == turnId)&&(identical(other.revision, revision) || other.revision == revision)&&(identical(other.text, text) || other.text == text)&&(identical(other.isFinal, isFinal) || other.isFinal == isFinal));
}


@override
int get hashCode => Object.hash(runtimeType,sessionId,turnId,revision,text,isFinal);

@override
String toString() {
  return 'DesktopCommand.runAzookey(sessionId: $sessionId, turnId: $turnId, revision: $revision, text: $text, isFinal: $isFinal)';
}


}

/// @nodoc
abstract mixin class $DesktopCommand_RunAzookeyCopyWith<$Res> implements $DesktopCommandCopyWith<$Res> {
  factory $DesktopCommand_RunAzookeyCopyWith(DesktopCommand_RunAzookey value, $Res Function(DesktopCommand_RunAzookey) _then) = _$DesktopCommand_RunAzookeyCopyWithImpl;
@useResult
$Res call({
 String sessionId, BigInt turnId, BigInt revision, String text, bool isFinal
});




}
/// @nodoc
class _$DesktopCommand_RunAzookeyCopyWithImpl<$Res>
    implements $DesktopCommand_RunAzookeyCopyWith<$Res> {
  _$DesktopCommand_RunAzookeyCopyWithImpl(this._self, this._then);

  final DesktopCommand_RunAzookey _self;
  final $Res Function(DesktopCommand_RunAzookey) _then;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? sessionId = null,Object? turnId = null,Object? revision = null,Object? text = null,Object? isFinal = null,}) {
  return _then(DesktopCommand_RunAzookey(
sessionId: null == sessionId ? _self.sessionId : sessionId // ignore: cast_nullable_to_non_nullable
as String,turnId: null == turnId ? _self.turnId : turnId // ignore: cast_nullable_to_non_nullable
as BigInt,revision: null == revision ? _self.revision : revision // ignore: cast_nullable_to_non_nullable
as BigInt,text: null == text ? _self.text : text // ignore: cast_nullable_to_non_nullable
as String,isFinal: null == isFinal ? _self.isFinal : isFinal // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class DesktopCommand_RunTranslation extends DesktopCommand {
  const DesktopCommand_RunTranslation({required this.sessionId, required this.turnId, required this.revision, required this.sourceText}): super._();


 final  String sessionId;
 final  BigInt turnId;
 final  BigInt revision;
 final  String sourceText;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DesktopCommand_RunTranslationCopyWith<DesktopCommand_RunTranslation> get copyWith => _$DesktopCommand_RunTranslationCopyWithImpl<DesktopCommand_RunTranslation>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand_RunTranslation&&(identical(other.sessionId, sessionId) || other.sessionId == sessionId)&&(identical(other.turnId, turnId) || other.turnId == turnId)&&(identical(other.revision, revision) || other.revision == revision)&&(identical(other.sourceText, sourceText) || other.sourceText == sourceText));
}


@override
int get hashCode => Object.hash(runtimeType,sessionId,turnId,revision,sourceText);

@override
String toString() {
  return 'DesktopCommand.runTranslation(sessionId: $sessionId, turnId: $turnId, revision: $revision, sourceText: $sourceText)';
}


}

/// @nodoc
abstract mixin class $DesktopCommand_RunTranslationCopyWith<$Res> implements $DesktopCommandCopyWith<$Res> {
  factory $DesktopCommand_RunTranslationCopyWith(DesktopCommand_RunTranslation value, $Res Function(DesktopCommand_RunTranslation) _then) = _$DesktopCommand_RunTranslationCopyWithImpl;
@useResult
$Res call({
 String sessionId, BigInt turnId, BigInt revision, String sourceText
});




}
/// @nodoc
class _$DesktopCommand_RunTranslationCopyWithImpl<$Res>
    implements $DesktopCommand_RunTranslationCopyWith<$Res> {
  _$DesktopCommand_RunTranslationCopyWithImpl(this._self, this._then);

  final DesktopCommand_RunTranslation _self;
  final $Res Function(DesktopCommand_RunTranslation) _then;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? sessionId = null,Object? turnId = null,Object? revision = null,Object? sourceText = null,}) {
  return _then(DesktopCommand_RunTranslation(
sessionId: null == sessionId ? _self.sessionId : sessionId // ignore: cast_nullable_to_non_nullable
as String,turnId: null == turnId ? _self.turnId : turnId // ignore: cast_nullable_to_non_nullable
as BigInt,revision: null == revision ? _self.revision : revision // ignore: cast_nullable_to_non_nullable
as BigInt,sourceText: null == sourceText ? _self.sourceText : sourceText // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class DesktopCommand_StopSession extends DesktopCommand {
  const DesktopCommand_StopSession({required this.sessionId}): super._();


 final  String sessionId;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DesktopCommand_StopSessionCopyWith<DesktopCommand_StopSession> get copyWith => _$DesktopCommand_StopSessionCopyWithImpl<DesktopCommand_StopSession>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand_StopSession&&(identical(other.sessionId, sessionId) || other.sessionId == sessionId));
}


@override
int get hashCode => Object.hash(runtimeType,sessionId);

@override
String toString() {
  return 'DesktopCommand.stopSession(sessionId: $sessionId)';
}


}

/// @nodoc
abstract mixin class $DesktopCommand_StopSessionCopyWith<$Res> implements $DesktopCommandCopyWith<$Res> {
  factory $DesktopCommand_StopSessionCopyWith(DesktopCommand_StopSession value, $Res Function(DesktopCommand_StopSession) _then) = _$DesktopCommand_StopSessionCopyWithImpl;
@useResult
$Res call({
 String sessionId
});




}
/// @nodoc
class _$DesktopCommand_StopSessionCopyWithImpl<$Res>
    implements $DesktopCommand_StopSessionCopyWith<$Res> {
  _$DesktopCommand_StopSessionCopyWithImpl(this._self, this._then);

  final DesktopCommand_StopSession _self;
  final $Res Function(DesktopCommand_StopSession) _then;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? sessionId = null,}) {
  return _then(DesktopCommand_StopSession(
sessionId: null == sessionId ? _self.sessionId : sessionId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class DesktopCommand_SetTranslationEnabled extends DesktopCommand {
  const DesktopCommand_SetTranslationEnabled({required this.enabled}): super._();


 final  bool enabled;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DesktopCommand_SetTranslationEnabledCopyWith<DesktopCommand_SetTranslationEnabled> get copyWith => _$DesktopCommand_SetTranslationEnabledCopyWithImpl<DesktopCommand_SetTranslationEnabled>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand_SetTranslationEnabled&&(identical(other.enabled, enabled) || other.enabled == enabled));
}


@override
int get hashCode => Object.hash(runtimeType,enabled);

@override
String toString() {
  return 'DesktopCommand.setTranslationEnabled(enabled: $enabled)';
}


}

/// @nodoc
abstract mixin class $DesktopCommand_SetTranslationEnabledCopyWith<$Res> implements $DesktopCommandCopyWith<$Res> {
  factory $DesktopCommand_SetTranslationEnabledCopyWith(DesktopCommand_SetTranslationEnabled value, $Res Function(DesktopCommand_SetTranslationEnabled) _then) = _$DesktopCommand_SetTranslationEnabledCopyWithImpl;
@useResult
$Res call({
 bool enabled
});




}
/// @nodoc
class _$DesktopCommand_SetTranslationEnabledCopyWithImpl<$Res>
    implements $DesktopCommand_SetTranslationEnabledCopyWith<$Res> {
  _$DesktopCommand_SetTranslationEnabledCopyWithImpl(this._self, this._then);

  final DesktopCommand_SetTranslationEnabled _self;
  final $Res Function(DesktopCommand_SetTranslationEnabled) _then;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? enabled = null,}) {
  return _then(DesktopCommand_SetTranslationEnabled(
enabled: null == enabled ? _self.enabled : enabled // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class DesktopCommand_Ping extends DesktopCommand {
  const DesktopCommand_Ping({required this.nonce}): super._();


 final  BigInt nonce;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DesktopCommand_PingCopyWith<DesktopCommand_Ping> get copyWith => _$DesktopCommand_PingCopyWithImpl<DesktopCommand_Ping>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DesktopCommand_Ping&&(identical(other.nonce, nonce) || other.nonce == nonce));
}


@override
int get hashCode => Object.hash(runtimeType,nonce);

@override
String toString() {
  return 'DesktopCommand.ping(nonce: $nonce)';
}


}

/// @nodoc
abstract mixin class $DesktopCommand_PingCopyWith<$Res> implements $DesktopCommandCopyWith<$Res> {
  factory $DesktopCommand_PingCopyWith(DesktopCommand_Ping value, $Res Function(DesktopCommand_Ping) _then) = _$DesktopCommand_PingCopyWithImpl;
@useResult
$Res call({
 BigInt nonce
});




}
/// @nodoc
class _$DesktopCommand_PingCopyWithImpl<$Res>
    implements $DesktopCommand_PingCopyWith<$Res> {
  _$DesktopCommand_PingCopyWithImpl(this._self, this._then);

  final DesktopCommand_Ping _self;
  final $Res Function(DesktopCommand_Ping) _then;

/// Create a copy of DesktopCommand
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? nonce = null,}) {
  return _then(DesktopCommand_Ping(
nonce: null == nonce ? _self.nonce : nonce // ignore: cast_nullable_to_non_nullable
as BigInt,
  ));
}


}

// dart format on
