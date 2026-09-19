param([string]$LockPath,[int]$OwnerPid,[string]$OwnerHost,[string]$Token,[ValidateSet('claim','release')][string]$Mode)
$ErrorActionPreference='Stop'
$stream=$null
try {
    # FileShare.Delete allows deletion while this handle still excludes ALL other
    # read/write openers. Thus release cannot delete a concurrently replaced owner.
    $fresh=$false
    if($Mode -eq 'claim') {
        try {$stream=[System.IO.File]::Open($LockPath,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::Delete);$fresh=$true}
        catch [System.IO.IOException] {$stream=[System.IO.File]::Open($LockPath,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::Delete)}
    } else {
        try {$stream=[System.IO.File]::Open($LockPath,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::Delete)}
        catch [System.IO.FileNotFoundException] {@{released=$true}|ConvertTo-Json -Compress;exit 0}
    }
    $reader=[System.IO.StreamReader]::new($stream,[System.Text.Encoding]::UTF8,$true,1024,$true)
    $text=$reader.ReadToEnd();$reader.Dispose()
    $previous=$null
    if($text) { try {$previous=$text|ConvertFrom-Json} catch {throw 'Cannot verify diagnostic lock ownership. Another instance may be starting; retry after it exits.'} }
    if(-not $fresh -and -not $previous) {throw 'Cannot verify diagnostic lock ownership. An empty or unknown owner will not be replaced.'}
    if($Mode -eq 'release') {
        if($previous -and $previous.token -eq $Token -and $previous.pid -eq $OwnerPid) { [System.IO.File]::Delete($LockPath) }
        @{released=$true}|ConvertTo-Json -Compress
    } else {
        if($previous) {
            if(-not $previous.pid -or $previous.pid -le 0 -or $previous.host -ne $OwnerHost -or -not $previous.token) {throw 'Cannot verify diagnostic lock ownership. It will not be taken over automatically.'}
            $owner=$null
            try {$owner=Get-Process -Id $previous.pid -ErrorAction Stop}
            catch {if($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound) {throw 'Cannot confirm the previous process is dead. Its lock will be preserved.'}}
            if($owner) {throw 'Another diagnostic instance is running. Close or cancel that instance before starting this campaign.'}
        }
        $payload=@{pid=$OwnerPid;host=$OwnerHost;token=$Token;createdAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress
        $bytes=[System.Text.Encoding]::UTF8.GetBytes($payload)
        $stream.Position=0;$stream.SetLength(0);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)
        @{claimed=$true;recovered=[bool]$previous}|ConvertTo-Json -Compress
    }
} catch {
    @{error= if($_.Exception -is [System.IO.IOException]) {'Another diagnostic instance is claiming its run. Try again in a moment.'} else {$_.Exception.Message}}|ConvertTo-Json -Compress
    exit 1
} finally { if($stream) {$stream.Dispose()} }
