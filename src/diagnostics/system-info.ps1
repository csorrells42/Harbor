$ErrorActionPreference='Stop'
$errors=@()
function Collect($Name,$Query) { try { & $Query } catch { $script:errors += "$Name unavailable"; @() } }
$cpu=@(Collect 'Processor' {Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed})
$memory=@(Collect 'Memory modules' {Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,ConfiguredClockSpeed,Speed,Manufacturer,PartNumber})
$disks=@(Collect 'Physical disks' {Get-CimInstance Win32_DiskDrive | Select-Object Model,Size,InterfaceType,MediaType})
$volumes=@(Collect 'Volumes' {Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 OR DriveType=2' | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace})
$video=@(Collect 'Display adapters' {Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion})
$os=@(Collect 'Operating system' {Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber})
[ordered]@{cpu=$cpu;memory=$memory;disks=$disks;volumes=$volumes;video=$video;os=$os;errors=$errors}|ConvertTo-Json -Depth 5 -Compress
