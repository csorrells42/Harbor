$ErrorActionPreference='Stop'
$sensors=[System.Collections.Generic.List[object]]::new()
$providers=[System.Collections.Generic.List[object]]::new()
foreach($provider in @('LibreHardwareMonitor','OpenHardwareMonitor')) {
  try {
    $hardware=@{}; Get-CimInstance -Namespace "root/$provider" -ClassName Hardware | ForEach-Object {$hardware[$_.Identifier]=$_.Name}
    $rows=@(Get-CimInstance -Namespace "root/$provider" -ClassName Sensor -Filter "SensorType='Temperature'")
    foreach($s in $rows) {if($null -ne $s.Value){$sensors.Add(@{id="$provider/$($s.Identifier)";label="$($hardware[$s.Parent]) $($s.Name)".Trim();source=$provider;celsius=[double]$s.Value})}}
    $providers.Add(@{name=$provider;status='available';detail="$($rows.Count) temperature sensors exposed"})
  } catch {$providers.Add(@{name=$provider;status='unavailable';detail='Sensor provider is not running or is inaccessible'})}
}
$performanceZones=0
try {
  # This counter is in whole degrees Kelvin (Microsoft thermal diagnostics documentation).
  $rows=@(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation)
  foreach($s in $rows){if($null -ne $s.Temperature -and $s.Temperature -gt 0){$sensors.Add(@{id="thermal-counter/$($s.Name)";label="Windows thermal zone $($s.Name)";source='Windows thermal counters';celsius=[math]::Round(([double]$s.Temperature)-273.15,1)});$performanceZones++}}
  $providers.Add(@{name='Windows thermal counters';status=$(if($performanceZones){'available'}else{'unavailable'});detail="$performanceZones firmware-reported zones; physical locations and freshness depend on firmware"})
} catch {$providers.Add(@{name='Windows thermal counters';status='unavailable';detail='Thermal performance counters are inaccessible or unsupported'})}
if($performanceZones -eq 0){try {
  $rows=@(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature)
  foreach($s in $rows){if($null -ne $s.CurrentTemperature -and $s.CurrentTemperature -gt 0){$sensors.Add(@{id="acpi/$($s.InstanceName)";label="ACPI thermal zone $($s.InstanceName)";source='Windows ACPI';celsius=[math]::Round(([double]$s.CurrentTemperature/10)-273.15,1)})}}
  $providers.Add(@{name='Windows ACPI';status='available';detail="$($rows.Count) zones exposed; zone names do not identify CPU cores"})
} catch {$providers.Add(@{name='Windows ACPI';status='unavailable';detail='Thermal zones are inaccessible or unsupported'})}}
try {
  $count=0; $missing=0
  foreach($d in @(Get-PhysicalDisk)) {
    try {
      $r=$d | Get-StorageReliabilityCounter
      # Windows storage providers commonly use zero when temperature is unsupported.
      if($null -ne $r.Temperature -and $r.Temperature -gt 0){$sensors.Add(@{id="storage/$($d.DeviceId)/$($d.FriendlyName)";label="Drive $($d.DeviceId): $($d.FriendlyName)";source='Windows storage';celsius=[double]$r.Temperature});$count++}else{$missing++}
    } catch {$missing++}
  }
  $providers.Add(@{name='Windows storage';status=$(if($count -gt 0){'available'}else{'unavailable'});detail="$count drive temperatures; $missing inaccessible or unsupported"})
} catch {$providers.Add(@{name='Windows storage';status='unavailable';detail='Drive temperature counters are inaccessible or unsupported'})}
@{sensors=@($sensors.ToArray());providers=@($providers.ToArray())}|ConvertTo-Json -Depth 5 -Compress
